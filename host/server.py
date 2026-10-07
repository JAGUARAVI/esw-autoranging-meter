#!/usr/bin/env python3
"""
ESWCap serial bridge + web dashboard backend.

Owns the ESP32 serial port, parses the firmware's "@@EVT {json}" telemetry
protocol, fans it out to browser clients over a WebSocket, and forwards
commands (calibration, tare, range, stream) back to the device.

Run:  uv run --project . host/server.py            (or use host/run.sh)
Then open http://127.0.0.1:8000
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import io
import json
import socket
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

import serial_asyncio
from serial.tools import list_ports
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

# Bounded history so a long-running session cannot exhaust memory.
HIST = {
    "cycle": deque(maxlen=4000),
    "sample": deque(maxlen=20000),
    "tare": deque(maxlen=4000),
    "calpt": deque(maxlen=2000),
    "calres": deque(maxlen=500),
    "fe": deque(maxlen=1000),
    "ack": deque(maxlen=2000),
    "adccalpt": deque(maxlen=2000),
    "adccalres": deque(maxlen=500),
    # Fusion / autoranging telemetry for the presentation view.
    "fuse": deque(maxlen=2000),
    "sweep": deque(maxlen=1000),
    "stat": deque(maxlen=500),
    # Waveform snapshots are large; keep a short tail so a late/reconnecting
    # client can still be handed the most recent curve.
    "curve": deque(maxlen=50),
}


def autodetect_port() -> str | None:
    """Prefer an ESP32 USB-CDC / UART bridge."""
    ports = list(list_ports.comports())
    for p in ports:
        if p.device.startswith("/dev/ttyACM"):
            return p.device
    for p in ports:
        if p.device.startswith("/dev/ttyUSB"):
            return p.device
    return ports[0].device if ports else None


def local_urls(port: int) -> list[str]:
    """Best-effort list of LAN URLs this dashboard is reachable at, so a phone
    or tablet on the same network can drive / watch the instrument."""
    urls: list[str] = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))          # no packets sent; picks the route IP
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith("127."):
            urls.append(f"http://{ip}:{port}")
    except Exception:  # noqa: BLE001
        pass
    return urls


class Hub:
    def __init__(self, port: str | None, baud: int):
        self.port = port
        self.baud = baud
        self.reconnected_port: str | None = None
        self.writer: asyncio.StreamWriter | None = None
        self.clients: set[WebSocket] = set()
        self._broadcast_lock = asyncio.Lock()
        self.status: dict = {"connected": False, "port": port, "baud": baud}
        self.log_lines: deque[str] = deque(maxlen=1000)
        # State snapshot for late-joining clients / the REST endpoint.
        self.latest: dict = {"cycle": None, "boot": None, "tare": None,
                             "calres": None, "calpt": None, "fe": None,
                             "ack": None, "adccalres": None, "adccalpt": None,
                             "fuse": None, "sweep": None, "stat": None,
                             "curve": None}
        self.curve_requested = False
        self.urls: list = []

    # ---- broadcast helpers -------------------------------------------------
    async def broadcast(self, message: dict) -> None:
        async with self._broadcast_lock:
            dead = []
            for ws in list(self.clients):
                try:
                    await ws.send_json(message)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self.clients.discard(ws)

    async def add_client(self, ws: WebSocket) -> None:
        self.clients.add(ws)
        # Tell the client to clear its local state FIRST: we are about to replay
        # history, and on a reconnect (same page) that would otherwise double-count
        # cycles into the rolling average and duplicate calibration scatter points.
        await ws.send_json({"type": "reset"})
        # Give the newcomer the full current picture, then live updates.
        await ws.send_json({"type": "status", **self.status})
        if self.latest["boot"]:
            await ws.send_json({"type": "event", "event": self.latest["boot"]})
        for kind, dq in HIST.items():
            if kind == "curve":
                continue  # large; sent once as a snapshot below
            for ev in list(dq)[-500:]:
                await ws.send_json({"type": "event", "event": ev})
        # History replays by event kind, not chronology, so the panel events must
        # be re-sent as a final snapshot in dependency order or a late/reconnecting
        # client could see a sweep with its fusion breakdown cleared.
        for kind in ("sweep", "fuse", "stat", "fe", "calres", "adccalres"):
            if self.latest.get(kind):
                await ws.send_json({"type": "event", "event": self.latest[kind]})
        if self.latest["curve"]:
            await ws.send_json({"type": "event", "event": self.latest["curve"]})
        for line in list(self.log_lines)[-200:]:
            await ws.send_json({"type": "log", "line": line})

    def remove_client(self, ws: WebSocket) -> None:
        self.clients.discard(ws)

    async def send_cmd(self, cmd: str) -> bool:
        if self.writer is None:
            return False
        # Exactly one firmware command per call: take only the first line so a
        # free-form console entry cannot inject several device commands at once.
        cmd = cmd.replace("\r", "\n").split("\n", 1)[0].strip()
        if not cmd:
            return False
        try:
            self.writer.write((cmd + "\n").encode())
            await self.writer.drain()
            return True
        except Exception as exc:  # noqa: BLE001
            await self._set_status(False, error=str(exc))
            return False

    async def _set_status(self, connected: bool, **extra) -> None:
        self.status = {"connected": connected, "port": self.port,
                       "baud": self.baud, "urls": self.urls, **extra}
        await self.broadcast({"type": "status", **self.status})

    # ---- serial ------------------------------------------------------------
    async def run(self) -> None:
        """Open the port (with reconnect) and pump lines forever."""
        while True:
            port = self.port or autodetect_port()
            self.port = port
            if not port:
                await self._set_status(False, error="no serial port found")
                await asyncio.sleep(2.0)
                continue
            try:
                reader, writer = await serial_asyncio.open_serial_connection(
                    url=port, baudrate=self.baud)
            except Exception as exc:  # noqa: BLE001
                await self._set_status(False, error=str(exc))
                await asyncio.sleep(2.0)
                continue

            self.writer = writer
            await self._set_status(True, error=None)
            # Ask the firmware for machine-readable telemetry.
            await self.send_cmd("stream on")
            if self.curve_requested:
                await self.send_cmd("curve on")

            try:
                while True:
                    raw = await reader.readline()
                    if not raw:
                        break
                    text = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                    if text:
                        await self.handle_line(text)
            except Exception as exc:  # noqa: BLE001
                await self._set_status(False, error=str(exc))
            finally:
                self.writer = None
                try:
                    writer.close()
                except Exception:  # noqa: BLE001
                    pass

            await self._set_status(False, error="port closed, reconnecting")
            await asyncio.sleep(1.0)

    async def handle_line(self, text: str) -> None:
        if text.startswith("@@EVT "):
            try:
                ev = json.loads(text[6:])
            except json.JSONDecodeError:
                return
            kind = ev.get("t")
            if kind == "boot":
                self.latest["boot"] = ev
            elif kind == "cycle":
                ev.setdefault("rx_unix_s", time.time())   # host receive time
                self.latest["cycle"] = ev
                HIST["cycle"].append(ev)
            elif kind == "tare":
                self.latest["tare"] = ev
                HIST["tare"].append(ev)
            elif kind == "calpt":
                self.latest["calpt"] = ev
                HIST["calpt"].append(ev)
            elif kind == "calres":
                self.latest["calres"] = ev
                HIST["calres"].append(ev)
            elif kind == "fe":
                self.latest["fe"] = ev
                HIST["fe"].append(ev)
            elif kind == "ack":
                self.latest["ack"] = ev
                HIST["ack"].append(ev)
            elif kind == "adccalres":
                self.latest["adccalres"] = ev
                HIST["adccalres"].append(ev)
            elif kind == "adccalpt":
                self.latest["adccalpt"] = ev
                HIST["adccalpt"].append(ev)
            elif kind == "fuse":
                ev.setdefault("rx_unix_s", time.time())
                self.latest["fuse"] = ev
                HIST["fuse"].append(ev)
            elif kind == "sweep":
                ev.setdefault("rx_unix_s", time.time())
                self.latest["sweep"] = ev
                HIST["sweep"].append(ev)
            elif kind == "stat":
                ev.setdefault("rx_unix_s", time.time())
                self.latest["stat"] = ev
                HIST["stat"].append(ev)
            elif kind == "curve":
                self.latest["curve"] = ev
                HIST["curve"].append(ev)
            elif kind == "sample":
                HIST["sample"].append(ev)
            await self.broadcast({"type": "event", "event": ev})
        else:
            self.log_lines.append(text)
            await self.broadcast({"type": "log", "line": text})


def make_app(hub: Hub) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        task = asyncio.create_task(hub.run())
        yield
        task.cancel()

    app = FastAPI(title="ESWCap dashboard", lifespan=lifespan)

    @app.get("/")
    async def index():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/api/state")
    async def state():
        return JSONResponse({
            "status": hub.status,
            "latest": hub.latest,
            "counts": {k: len(v) for k, v in HIST.items()},
        })

    @app.get("/api/summary")
    async def summary():
        """Session aggregate for the dashboard summary / presentation panel."""
        cyc = list(HIST["cycle"])
        cs = [c["c"] for c in cyc
              if c.get("valid") and isinstance(c.get("c"), (int, float)) and c["c"] > 0]
        spreads = [c["spread"] for c in cyc if isinstance(c.get("spread"), (int, float))]

        def stats(xs):
            if not xs:
                return None
            n = len(xs)
            mean = sum(xs) / n
            var = sum((x - mean) ** 2 for x in xs) / n
            return {"n": n, "mean": mean, "min": min(xs),
                    "max": max(xs), "stdev": var ** 0.5}

        return JSONResponse({
            "cycles": len(cyc),
            "valid_cycles": len(cs),
            "cap_F": stats(cs),
            "spread": stats(spreads),
            "fuse_events": len(HIST["fuse"]),
            "samples": len(HIST["sample"]),
            "stat": hub.latest.get("stat"),
            "status": hub.status,
        })

    @app.get("/api/export.csv")
    async def export_csv():
        buf = io.StringIO()
        w = csv.writer(buf)

        w.writerow(["# cycles"])
        w.writerow(["rx_unix_s", "device_ts_ms", "valid", "c_F", "spread",
                    "weight", "n_adc", "n_osc", "raw", "adc_F", "osc_F", "mismatch"])
        for ev in HIST["cycle"]:
            w.writerow([f"{ev.get('rx_unix_s', 0.0):.3f}", ev.get("ts_ms"), ev.get("valid"),
                        ev.get("c"), ev.get("spread"), ev.get("weight"),
                        ev.get("n_adc"), ev.get("n_osc"), ev.get("raw"),
                        ev.get("adc"), ev.get("osc"), ev.get("mismatch")])

        w.writerow([])
        w.writerow(["# samples"])
        w.writerow(["phase", "method", "range", "label", "valid", "plausible",
                    "c_F", "c_eq_F", "q", "tau_us", "freq_hz", "r2", "vinf_mv"])
        for ev in HIST["sample"]:
            w.writerow([ev.get("phase"), ev.get("method"), ev.get("range"),
                        ev.get("label"), ev.get("valid"), ev.get("plausible"),
                        ev.get("c"), ev.get("c_eq"), ev.get("q"), ev.get("tau_us"),
                        ev.get("freq"), ev.get("r2"), ev.get("vinf")])

        w.writerow([])
        w.writerow(["# tare"])
        w.writerow(["range", "idx", "total", "freq_hz", "period_us",
                    "t0_us", "stray_pf", "done"])
        for ev in HIST["tare"]:
            w.writerow([ev.get("range"), ev.get("idx"), ev.get("total"),
                        ev.get("freq"), ev.get("period_us"), ev.get("t0_us"),
                        ev.get("stray_pf"), ev.get("done")])

        w.writerow([])
        w.writerow(["# calibration"])
        w.writerow(["kind", "op", "range", "ref_pf", "freq_hz", "period_us",
                    "k", "t0_us", "ok"])
        for ev in HIST["calpt"]:
            w.writerow(["calpt", ev.get("op"), ev.get("range"), ev.get("ref_pf"),
                        ev.get("freq"), ev.get("period_us"), "", "", ""])
        for ev in HIST["calres"]:
            w.writerow(["calres", ev.get("op"), ev.get("range"), "", "", "",
                        ev.get("k"), ev.get("t0_us"), ev.get("ok")])

        w.writerow([])
        w.writerow(["# fusion breakdown"])
        w.writerow(["rx_unix_s", "median_F", "fused_F", "c_min_F", "c_max_F",
                    "spread", "n_kept", "n_gated", "w_total"])
        for ev in HIST["fuse"]:
            w.writerow([f"{ev.get('rx_unix_s', 0.0):.3f}", ev.get("median"), ev.get("c"),
                        ev.get("c_min"), ev.get("c_max"), ev.get("spread"),
                        ev.get("n_kept"), ev.get("n_gated"), ev.get("w_total")])

        w.writerow([])
        w.writerow(["# fusion contributions"])
        w.writerow(["rx_unix_s", "range", "label", "method", "c_F", "c_eq_F",
                    "q", "w", "r2", "kept"])
        for ev in HIST["fuse"]:
            ts = f"{ev.get('rx_unix_s', 0.0):.3f}"
            for c in ev.get("contrib", []):
                w.writerow([ts, c.get("r"), c.get("label"), c.get("m"),
                            c.get("c"), c.get("c_eq"), c.get("q"), c.get("w"),
                            c.get("r2"), c.get("kept")])

        w.writerow([])
        w.writerow(["# autoranging decisions"])
        w.writerow(["rx_unix_s", "mode", "have_rough", "rough_F", "sub_nf",
                    "saturated", "adc_sub", "osc_best", "lock", "adc_tried"])
        for ev in HIST["sweep"]:
            w.writerow([f"{ev.get('rx_unix_s', 0.0):.3f}", ev.get("mode"),
                        ev.get("have_rough"), ev.get("rough"), ev.get("sub_nf"),
                        ev.get("saturated"), ev.get("adc_sub"), ev.get("osc_best"),
                        ev.get("lock"), ";".join(str(b) for b in ev.get("adc_tried", []))])

        w.writerow([])
        w.writerow(["# device stats"])
        w.writerow(["rx_unix_s", "uptime_ms", "cycles", "cycle_ms", "heap_free", "heap_min"])
        for ev in HIST["stat"]:
            w.writerow([f"{ev.get('rx_unix_s', 0.0):.3f}", ev.get("uptime_ms"),
                        ev.get("cycles"), ev.get("cycle_ms"), ev.get("heap_free"),
                        ev.get("heap_min")])

        return StreamingResponse(
            iter([buf.getvalue()]), media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=eswcap.csv"})

    @app.websocket("/ws")
    async def ws(websocket: WebSocket):
        await websocket.accept()
        await hub.add_client(websocket)
        try:
            while True:
                data = await websocket.receive_json()
                mtype = data.get("type")
                if mtype == "cmd":
                    cmd = str(data.get("cmd", "")).strip()
                    if cmd:
                        ok = await hub.send_cmd(cmd)
                        if not ok:
                            await websocket.send_json(
                                {"type": "log", "line": f"[host] command failed: {cmd}"})
                elif mtype == "curve":
                    hub.curve_requested = bool(data.get("on"))
                    await hub.send_cmd("curve on" if hub.curve_requested else "curve off")
        except WebSocketDisconnect:
            pass
        except Exception:  # noqa: BLE001
            pass
        finally:
            hub.remove_client(websocket)

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


def main() -> None:
    ap = argparse.ArgumentParser(description="ESWCap web dashboard")
    ap.add_argument("--port", default=None, help="serial device (autodetect if omitted)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--web-port", type=int, default=8000)
    args = ap.parse_args()

    hub = Hub(args.port, args.baud)
    app = make_app(hub)

    hub.urls = local_urls(args.web_port)
    if hub.urls:
        print("[host] dashboard also reachable on the LAN at:")
        for u in hub.urls:
            print("  " + u)
        if args.host in ("127.0.0.1", "localhost"):
            print("[host] (start with --host 0.0.0.0 to actually allow LAN access)")

    import uvicorn
    uvicorn.run(app, host=args.host, port=args.web_port, log_level="info")


if __name__ == "__main__":
    main()