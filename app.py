"""EMT Madrid en vivo: tiempos de llegada + alertas push para iPhone (PWA)."""
import base64
import json
import os
import threading
import time
import uuid
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory

from emt import EMTClient, EMTError

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")

DATA_FILE = ROOT / "data.json"
VAPID_FILE = ROOT / "vapid_private.pem"
VAPID_SUB = os.getenv("VAPID_SUB", "mailto:admin@example.com")
CHECK_EVERY = 20          # segundos entre comprobaciones de alertas
WATCH_TTL = 2 * 3600      # una alerta caduca a las 2 h si no se dispara

app = Flask(__name__, static_folder="static", static_url_path="")
if os.getenv("EMT_DEMO") == "1":  # datos falsos para probar la interfaz sin credenciales
    from demo import DemoClient as EMTClient  # noqa: F811
emt = EMTClient(os.getenv("EMT_CLIENT_ID"), os.getenv("EMT_PASSKEY"),
                email=os.getenv("EMT_EMAIL"), password=os.getenv("EMT_PASSWORD"))
store_lock = threading.Lock()


# ---- persistencia sencilla en JSON ----------------------------------------
def load_store():
    if DATA_FILE.exists():
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    return {"watches": []}


def save_store(store):
    DATA_FILE.write_text(json.dumps(store, indent=2), encoding="utf-8")


# ---- claves VAPID ----------------------------------------------------------
# En el servidor van en VAPID_PRIVATE_KEY (PEM en base64), porque el disco se borra en cada
# despliegue y, si la clave cambia, el iPhone deja de recibir avisos. En local se genera un .pem.
def load_vapid():
    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid01

    if os.getenv("VAPID_PRIVATE_KEY"):
        v = Vapid01.from_pem(base64.b64decode(os.environ["VAPID_PRIVATE_KEY"]))
    else:
        if not VAPID_FILE.exists():
            v = Vapid01()
            v.generate_keys()
            v.save_key(str(VAPID_FILE))
        v = Vapid01.from_file(str(VAPID_FILE))
    raw = v.public_key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return v, base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


VAPID, VAPID_PUBLIC = load_vapid()
APP_KEY = os.getenv("APP_KEY", "")  # si se define, la API exige la cabecera X-App-Key


@app.before_request
def require_key():
    if APP_KEY and request.path.startswith("/api/") and request.path != "/api/check":
        if request.headers.get("X-App-Key") != APP_KEY:
            return jsonify({"error": "clave", "needKey": True}), 401


def send_push(subscription, title, body, tag):
    from pywebpush import webpush

    try:
        webpush(
            subscription_info=subscription,
            data=json.dumps({"title": title, "body": body, "tag": tag}),
            vapid_private_key=VAPID,
            vapid_claims={"sub": VAPID_SUB},
            ttl=120,
        )
        return True
    except Exception as e:  # WebPushException, red caída, etc.
        print("Push falló:", e)
        return False


# ---- API ------------------------------------------------------------------
@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/arrivals/<int:stop_id>")
def arrivals(stop_id):
    try:
        return jsonify(emt.arrivals(stop_id))
    except EMTError as e:
        return jsonify({"error": str(e)}), 502
    except Exception as e:  # red caída, JSON raro, etc.
        return jsonify({"error": f"No se pudo consultar la EMT: {e}"}), 502


@app.get("/api/vapid")
def vapid():
    return jsonify({"publicKey": VAPID_PUBLIC})


@app.get("/api/watches")
def list_watches():
    endpoint = request.args.get("endpoint")
    with store_lock:
        ws = [w for w in load_store()["watches"] if not endpoint or w["sub"]["endpoint"] == endpoint]
    return jsonify([{k: w[k] for k in ("id", "stop", "line", "minutes", "created")} for w in ws])


@app.post("/api/watches")
def add_watch():
    p = request.get_json(force=True)
    try:
        watch = {
            "id": uuid.uuid4().hex[:10],
            "stop": str(int(p["stop"])),
            "line": str(p["line"]).strip().upper(),
            "minutes": max(1, min(30, int(p["minutes"]))),
            "sub": p["subscription"],
            "created": time.time(),
        }
    except (KeyError, ValueError, TypeError):
        return jsonify({"error": "Datos de alerta incompletos"}), 400
    with store_lock:
        store = load_store()
        store["watches"].append(watch)
        save_store(store)
    return jsonify({"id": watch["id"]})


@app.delete("/api/watches/<wid>")
def delete_watch(wid):
    with store_lock:
        store = load_store()
        store["watches"] = [w for w in store["watches"] if w["id"] != wid]
        save_store(store)
    return jsonify({"ok": True})


@app.get("/api/check")
def check_now():
    # lo llama un servicio externo (cron-job.org) cada pocos minutos: mantiene despierto el
    # servidor gratuito y además revisa las alertas en ese momento
    check_watches()
    return jsonify({"ok": True, "watches": len(load_store()["watches"])})


@app.post("/api/test-push")
def test_push():
    sub = request.get_json(force=True).get("subscription")
    ok = send_push(sub, "🚌 Prueba", "Las alertas funcionan en este dispositivo", "test")
    return jsonify({"ok": ok})


# ---- vigilante en segundo plano --------------------------------------------
check_lock = threading.Lock()


def check_watches():
    # el hilo y /api/check pueden coincidir: así una alerta no se manda dos veces
    if not check_lock.acquire(blocking=False):
        return
    try:
        _check_watches()
    finally:
        check_lock.release()


def _check_watches():
    with store_lock:
        watches = load_store()["watches"]
    if not watches:
        return
    fired, now = set(), time.time()
    for w in watches:
        if now - w["created"] > WATCH_TTL:
            fired.add(w["id"])
            continue
        try:
            data = emt.arrivals(w["stop"])
        except Exception as e:
            print("Vigilante: error EMT", e)
            continue
        etas = [b["eta"] for b in data["buses"] if b["line"] == w["line"] and b["eta"] is not None]
        if not etas:
            continue
        eta = min(etas)
        if eta <= w["minutes"] * 60:
            mins = max(0, round(eta / 60))
            msg = "¡está llegando!" if mins == 0 else f"llega en {mins} min, ¡sal ya!"
            send_push(w["sub"], f"🚌 Línea {w['line']} {msg}", data["name"], f"w-{w['id']}")
            fired.add(w["id"])
    if fired:
        with store_lock:
            store = load_store()
            store["watches"] = [w for w in store["watches"] if w["id"] not in fired]
            save_store(store)


def watcher_loop():
    while True:
        try:
            check_watches()
        except Exception as e:
            print("Vigilante:", e)
        time.sleep(CHECK_EVERY)


threading.Thread(target=watcher_loop, daemon=True).start()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 5055)), debug=False)
