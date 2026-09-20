import json
import logging
import os
import threading
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from flask import Flask, jsonify, render_template, request, send_from_directory
from flask_sock import Sock
from werkzeug.utils import secure_filename

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s"
)
logger = logging.getLogger("pastebin.server")

app = Flask(__name__)
sock = Sock(app)

MANILA_TZ = ZoneInfo("Asia/Manila")
BASE_DIR = Path(__file__).resolve().parent
PASTE_PATH = BASE_DIR / "pastebin.txt"
IMAGES_DIR = BASE_DIR / "pastebin_images"
IMAGES_DIR.mkdir(exist_ok=True)

IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/x-ms-bmp": ".bmp",
    "image/avif": ".avif",
    "image/svg+xml": ".svg",
    "image/heic": ".heic",
    "image/heif": ".heif",
}
IMAGE_EXTENSIONS = set(IMAGE_TYPES.values()) | {".jpeg"}

# state_lock guards paste_text and the file write, so memory and disk never diverge.
paste_text = ""
state_lock = threading.Lock()

# Each socket gets its own send lock: a websocket must not be written to from
# two threads at once, but one slow client shouldn't block sends to the others.
clients = {}
clients_lock = threading.Lock()


def save_paste(text):
    # Write to a temp file and rename so a crash mid-write can't corrupt the paste.
    tmp = PASTE_PATH.with_suffix(".tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(PASTE_PATH)
    except OSError as error:
        logger.warning("Could not save %s: %s", PASTE_PATH.name, error)


def load_saved_paste():
    global paste_text
    try:
        paste_text = PASTE_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        pass
    except OSError as error:
        logger.warning("Could not load %s: %s", PASTE_PATH.name, error)


def safe_send(ws, lock, payload):
    try:
        with lock:
            ws.send(payload)
        return True
    except Exception:
        return False


def broadcast_state(exclude=None):
    """Send the current text and user count to every client except `exclude`."""
    with clients_lock:
        targets = list(clients.items())
    with state_lock:
        text = paste_text

    payload = json.dumps({"type": "update", "text": text, "users": len(targets)})
    dead = [
        ws
        for ws, lock in targets
        if ws is not exclude and not safe_send(ws, lock, payload)
    ]
    if dead:
        with clients_lock:
            for ws in dead:
                clients.pop(ws, None)


load_saved_paste()


@app.get("/")
def pastebin_page():
    return render_template("index.html")


@app.post("/pastebin-image")
def pastebin_image_upload():
    image = request.files.get("image")
    if image is None or not image.filename:
        return jsonify(error="Missing image file"), 400

    extension = IMAGE_TYPES.get((image.mimetype or "").lower())
    if not extension:
        guessed = Path(secure_filename(image.filename)).suffix.lower()
        if guessed not in IMAGE_EXTENSIONS:
            return jsonify(error="Unsupported image type"), 400
        extension = ".jpg" if guessed == ".jpeg" else guessed

    timestamp = datetime.now(MANILA_TZ).strftime("%Y%m%d_%H%M%S_%f")
    filename = f"paste_{timestamp}{extension}"
    image.save(IMAGES_DIR / filename)
    logger.info("Pastebin image uploaded: file=%s", filename)
    return jsonify(url=f"/pastebin-image/{filename}"), 201


@app.get("/pastebin-image/<filename>")
def pastebin_image_view(filename):
    # send_from_directory rejects path traversal and 404s on missing files.
    return send_from_directory(IMAGES_DIR, filename)


@sock.route("/pastebin-ws")
def pastebin_websocket(ws):
    global paste_text
    send_lock = threading.Lock()
    with clients_lock:
        clients[ws] = send_lock

    # Also delivers the current state to the newly connected client.
    broadcast_state()

    try:
        while (raw := ws.receive()) is not None:
            try:
                data = json.loads(raw)
            except (TypeError, ValueError):
                continue
            if not isinstance(data, dict) or data.get("type") != "update":
                continue

            text = str(data.get("text", ""))
            with state_lock:
                paste_text = text
                save_paste(text)
            broadcast_state(exclude=ws)
            safe_send(ws, send_lock, '{"type": "saved"}')
    except Exception:
        pass
    finally:
        with clients_lock:
            clients.pop(ws, None)
        broadcast_state()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5001")), debug=False)
