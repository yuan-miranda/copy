import json
import logging
import os
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
import threading

from flask import (
    Flask,
    Response,
    abort,
    jsonify,
    render_template,
    request,
    send_from_directory,
)
from flask_sock import Sock
from werkzeug.utils import secure_filename

# --- Logging Setup ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
)
logger = logging.getLogger("pastebin.server")

# --- App Initialization ---
app = Flask(__name__)
sock = Sock(app)

# --- Configuration & Paths ---
MANILA_TIMEZONE = ZoneInfo("Asia/Manila")
PASTE_PATH = Path(__file__).resolve().with_name("pastebin.txt")
PASTE_IMAGES_DIR = Path(__file__).resolve().parent / "pastebin_images"
PASTE_IMAGES_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_IMAGE_TYPES = {
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
ALLOWED_IMAGE_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".svg", ".heic", ".heif",
}

# --- State Management ---
paste_text = ""
paste_lock = threading.Lock()
paste_clients = set()
paste_clients_lock = threading.Lock()
send_lock = threading.Lock()


def load_saved_paste():
    global paste_text
    if PASTE_PATH.is_file():
        try:
            paste_text = PASTE_PATH.read_text(encoding="utf-8")
        except OSError as error:
            logger.warning("Could not load pastebin.txt: %s", error)


def broadcast_state(exclude=None):
    """Broadcasts paste text and active user count to all connected clients."""
    with paste_clients_lock:
        user_count = len(paste_clients)
        sockets = list(paste_clients)
        
    payload = json.dumps({"type": "update", "text": paste_text, "users": user_count})
    for websocket in sockets:
        if websocket is exclude:
            continue
        try:
            with send_lock:
                websocket.send(payload)
        except Exception:
            with paste_clients_lock:
                paste_clients.discard(websocket)


load_saved_paste()


# --- Flask Routes ---

@app.get("/")
def pastebin_page():
    return render_template("index.html", paste_text=paste_text)


@app.post("/pastebin-image")
def pastebin_image_upload():
    image = request.files.get("image")
    if image is None or not image.filename:
        return jsonify(error="Missing image file"), 400

    content_type = (image.mimetype or "").lower()
    extension = ALLOWED_IMAGE_TYPES.get(content_type)
    if not extension:
        guessed = Path(secure_filename(image.filename)).suffix.lower()
        if guessed in ALLOWED_IMAGE_EXTENSIONS:
            extension = ".jpg" if guessed == ".jpeg" else guessed
        else:
            return jsonify(error="Unsupported image type"), 400

    timestamp = datetime.now(MANILA_TIMEZONE).strftime("%Y%m%d_%H%M%S_%f")
    filename = f"paste_{timestamp}{extension}"
    image.save(PASTE_IMAGES_DIR / filename)
    logger.info("Pastebin image uploaded: file=%s", filename)
    return jsonify(url=f"/pastebin-image/{filename}"), 201


@app.get("/pastebin-image/<path:filename>")
def pastebin_image_view(filename):
    safe_filename = Path(filename)
    if safe_filename.name != filename:
        abort(404)

    image_path = PASTE_IMAGES_DIR / safe_filename.name
    if not image_path.is_file():
        abort(404)

    return send_from_directory(PASTE_IMAGES_DIR, safe_filename.name)


@sock.route("/pastebin-ws")
def pastebin_websocket(ws):
    global paste_text
    with paste_clients_lock:
        paste_clients.add(ws)
    
    # Broadcast new user count on connect
    broadcast_state()

    try:
        with send_lock:
            with paste_clients_lock:
                count = len(paste_clients)
            ws.send(json.dumps({"type": "update", "text": paste_text, "users": count}))
            
        while True:
            raw = ws.receive()
            if raw is None:
                break
            try:
                data = json.loads(raw)
            except (TypeError, json.JSONDecodeError):
                continue
            if data.get("type") == "update":
                text = str(data.get("text", ""))
                with paste_lock:
                    paste_text = text
                    try:
                        PASTE_PATH.write_text(text, encoding="utf-8")
                    except OSError as error:
                        logger.warning("Could not save pastebin.txt: %s", error)
                broadcast_state(exclude=ws)
                try:
                    with send_lock:
                        ws.send(json.dumps({"type": "saved"}))
                except Exception:
                    pass
    except Exception:
        pass
    finally:
        with paste_clients_lock:
            paste_clients.discard(ws)
        broadcast_state()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5001")), debug=False)