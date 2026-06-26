#!/usr/bin/env python3
"""
officeOs Slack Watcher — standalone PM2-managed process.
Bridges Slack Socket Mode to cortextOS file bus and IPC.
"""

import os
import sys
import json
import time
import socket
import logging
import hashlib
import hmac as hmac_mod
import re
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

# ── Config ────────────────────────────────────────────────────────────────────
BOT_TOKEN       = os.environ['SLACK_BOT_TOKEN']
APP_TOKEN       = os.environ['SLACK_APP_TOKEN']
CHANNEL_ID      = os.getenv('SLACK_CHANNEL_ID', '')
ALLOWED_USER_ID = os.getenv('SLACK_USER_ID', '')
CTX_ROOT        = Path(os.getenv('CTX_ROOT', str(Path.home() / '.officeos' / 'default')))
INSTANCE_ID     = os.getenv('CTX_INSTANCE_ID', 'default')
ORCH_NAME       = os.getenv('ORCHESTRATOR_NAME', 'orchestrator')
BUS_SIGN_KEY    = os.getenv('BUS_SIGNING_KEY', '')

DAEMON_SOCK = Path.home() / '.cortextos' / INSTANCE_ID / 'daemon.sock'
INBOX_DIR   = CTX_ROOT / 'inbox' / ORCH_NAME
STATE_DIR   = CTX_ROOT / 'state' / ORCH_NAME

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [slack-watcher] %(levelname)s %(message)s',
)
log = logging.getLogger(__name__)

# ── IPC helpers ───────────────────────────────────────────────────────────────
def ipc_send(payload: dict) -> dict | None:
    """Send JSON to daemon IPC socket, return parsed response or None."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(5)
            s.connect(str(DAEMON_SOCK))
            s.sendall((json.dumps(payload) + '\n').encode())
            data = b''
            while True:
                chunk = s.recv(4096)
                if not chunk:
                    break
                data += chunk
                try:
                    return json.loads(data.decode())
                except json.JSONDecodeError:
                    continue
    except Exception as e:
        log.warning(f'IPC error: {e}')
        return None


def ensure_orchestrator_running() -> None:
    """Start orchestrator via IPC if not already running."""
    status = ipc_send({'command': 'status', 'agent': ORCH_NAME})
    if status and status.get('agents', {}).get(ORCH_NAME, {}).get('status') == 'running':
        return
    log.info(f'Orchestrator {ORCH_NAME} not running — sending start-agent IPC')
    ipc_send({'command': 'start-agent', 'agent': ORCH_NAME})
    time.sleep(2)

# ── Bus write ─────────────────────────────────────────────────────────────────
def write_inbox(text: str, from_user: str) -> None:
    """Write a message to the orchestrator inbox file bus."""
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    epoch_ms = int(time.time() * 1000)
    rand = hashlib.md5(f'{epoch_ms}{from_user}'.encode()).hexdigest()[:6]
    fname = f'001-{epoch_ms}-from-slack-watcher-{rand}.json'
    payload = {
        'id': fname,
        'from': 'slack-user',
        'to': ORCH_NAME,
        'priority': 'normal',
        'text': text,
        'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    if BUS_SIGN_KEY:
        sig = hmac_mod.new(BUS_SIGN_KEY.encode(), json.dumps(payload).encode(), 'sha256').hexdigest()
        payload['_sig'] = sig
    (INBOX_DIR / fname).write_text(json.dumps(payload), encoding='utf-8')
    log.info(f'Wrote inbox: {fname}')

# ── Approval handler ──────────────────────────────────────────────────────────
ALLOW_RE = re.compile(r'^allow$', re.IGNORECASE)
DENY_RE  = re.compile(r'^deny$', re.IGNORECASE)


def handle_approval_reply(text: str) -> bool:
    """
    If text is 'allow' or 'deny', find latest pending hook-response or
    tool-approval file and write decision. Returns True if handled.
    """
    text = text.strip()
    if not (ALLOW_RE.match(text) or DENY_RE.match(text)):
        return False

    decision = 'allow' if ALLOW_RE.match(text) else 'deny'
    STATE_DIR.mkdir(parents=True, exist_ok=True)

    # Check hook-response pending files first, then tool-approval
    pending_files = sorted(STATE_DIR.glob('hook-response-*.pending'), key=lambda p: p.stat().st_mtime)
    prefix = 'hook-response'
    if not pending_files:
        pending_files = sorted(STATE_DIR.glob('tool-approval-*.pending'), key=lambda p: p.stat().st_mtime)
        prefix = 'tool-approval'

    if not pending_files:
        log.info(f'Got "{decision}" but no pending approval files found')
        return True

    pending = pending_files[-1]
    try:
        meta = json.loads(pending.read_text())
    except Exception:
        meta = {}

    unique_id = meta.get('uniqueId') or meta.get('approvalId')
    if not unique_id:
        log.warning(f'No uniqueId in pending file: {pending}')
        return True

    response_file = STATE_DIR / f'{prefix}-{unique_id}.json'
    response_file.write_text(json.dumps({'decision': decision, 'ts': time.time()}), encoding='utf-8')
    log.info(f'Written approval: {decision} → {response_file.name}')
    try:
        pending.unlink()
    except Exception:
        pass
    return True

# ── Slack app ─────────────────────────────────────────────────────────────────
app = App(token=BOT_TOKEN)


@app.event('message')
def handle_message(event, say, logger):
    user_id   = event.get('user', '')
    text      = (event.get('text') or '').strip()
    channel   = event.get('channel', '')
    chan_type  = event.get('channel_type', '')
    bot_id    = event.get('bot_id')  # bot messages have this set

    # Ignore bot messages (including our own)
    if bot_id:
        return

    # Filter by allowed user
    if ALLOWED_USER_ID and user_id != ALLOWED_USER_ID:
        logger.info(f'Ignored message from unauthorized user {user_id}')
        return

    # Only handle DMs or configured channel
    is_dm = chan_type == 'im'
    is_configured = channel == CHANNEL_ID
    if not is_dm and not is_configured:
        return

    # Check approval reply first
    if handle_approval_reply(text):
        return

    # Otherwise route to orchestrator inbox
    ensure_orchestrator_running()
    write_inbox(text, user_id)


if __name__ == '__main__':
    log.info(f'Starting Slack watcher (channel: {CHANNEL_ID}, user: {ALLOWED_USER_ID})')
    handler = SocketModeHandler(app, APP_TOKEN)
    handler.start()
