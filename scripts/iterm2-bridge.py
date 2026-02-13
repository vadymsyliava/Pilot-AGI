#!/usr/bin/env python3
"""
iTerm2 Python API Bridge (Phase 6.2)

Persistent bridge process that communicates with iTerm2 via its Python API.
Node.js sends JSON commands via stdin, receives JSON responses via stdout.

Commands: open, close, send, read, list, detect, badge

Protocol: One JSON object per line (newline-delimited JSON).
Request:  {"id": "req-1", "action": "open", "command": "echo hello", ...}
Response: {"id": "req-1", "ok": true, "terminalId": "session-uuid", ...}
Error:    {"id": "req-1", "ok": false, "error": "message"}

Part of Phase 6.2 (Pilot AGI-3du)
"""

import asyncio
import json
import sys
import os
import re

# ANSI escape sequence regex for clean output
ANSI_RE = re.compile(r'\x1B(?:\[[0-9;]*[A-Za-z]|\].*?(?:\x07|\x1B\\)|\([A-Z0-9])')

# State detection patterns (mirrors applescript-bridge.js)
STATE_PATTERNS = {
    'error': re.compile(r'Error:|FATAL|panic|Traceback|ENOENT|EACCES'),
    'checkpoint': re.compile(r'CHECKPOINT SAVED|Context pressure: [89]\d%|Context pressure: 100%'),
    'plan_approval': re.compile(r'Waiting for plan approval|Approve this plan\?'),
    'complete': re.compile(r'All plan steps complete|Task complete'),
    'waiting_input': re.compile(r'\?\s+(?:yes|no|approve|reject)', re.IGNORECASE),
    'working': re.compile(r'[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|Running|Executing'),
    'idle': re.compile(r'^>\s*$', re.MULTILINE),
}

STATE_PRIORITY = [
    'error', 'checkpoint', 'plan_approval', 'complete',
    'waiting_input', 'working', 'idle'
]


def strip_ansi(text):
    """Remove ANSI escape sequences from text."""
    if not text:
        return ''
    return ANSI_RE.sub('', text)


def detect_state(text):
    """Detect Claude Code session state from terminal output."""
    if not text:
        return {'state': 'unknown', 'match': None}

    clean = strip_ansi(text)
    for state_name in STATE_PRIORITY:
        pattern = STATE_PATTERNS[state_name]
        m = pattern.search(clean)
        if m:
            return {'state': state_name, 'match': m.group(0)}

    return {'state': 'unknown', 'match': None}


class ITerm2Bridge:
    """Bridge between Node.js and iTerm2 Python API."""

    def __init__(self):
        self.sessions = {}  # session_id -> Session object
        self.connection = None

    async def handle_command(self, cmd):
        """Route a command to the appropriate handler."""
        action = cmd.get('action', '')
        req_id = cmd.get('id', '')

        try:
            if action == 'open':
                return await self._open(cmd)
            elif action == 'close':
                return await self._close(cmd)
            elif action == 'send':
                return await self._send(cmd)
            elif action == 'read':
                return await self._read(cmd)
            elif action == 'list':
                return await self._list(cmd)
            elif action == 'detect':
                return await self._detect(cmd)
            elif action == 'badge':
                return await self._badge(cmd)
            elif action == 'ping':
                return {'ok': True, 'pong': True}
            else:
                return {'ok': False, 'error': f'Unknown action: {action}'}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    async def _open(self, cmd):
        """Open a new terminal window/tab and optionally run a command."""
        import iterm2

        command = cmd.get('command', '')
        title = cmd.get('title', '')
        cwd = cmd.get('cwd', '')
        env = cmd.get('env', {})
        target = cmd.get('target', 'window')  # window | tab | split

        if target == 'tab':
            # Create a new tab in the current window
            app = await iterm2.async_get_app(self.connection)
            window = app.current_terminal_window
            if window is None:
                window = await iterm2.Window.async_create(self.connection)
            else:
                tab = await window.async_create_tab()
                session = tab.current_session
        elif target == 'split':
            # Split the current session
            app = await iterm2.async_get_app(self.connection)
            window = app.current_terminal_window
            if window is None:
                window = await iterm2.Window.async_create(self.connection)
                session = window.current_tab.current_session
            else:
                parent_session = window.current_tab.current_session
                direction = cmd.get('direction', 'vertical') == 'vertical'
                session = await parent_session.async_split_pane(vertical=direction)
        else:
            # Create a new window
            window = await iterm2.Window.async_create(self.connection)
            session = window.current_tab.current_session

        # If we created a tab, session is already set above
        if target == 'tab':
            pass  # session already assigned
        elif target != 'split':
            session = window.current_tab.current_session

        # Set working directory
        if cwd:
            await session.async_send_text(f'cd {cwd}\n')

        # Set environment variables
        for key, value in env.items():
            await session.async_send_text(f'export {key}="{value}"\n')

        # Set title
        if title:
            await session.async_send_text(f"printf '\\e]1;{title}\\a'\n")

        # Run command
        if command:
            await session.async_send_text(command + '\n')

        # Set badge if available
        badge = cmd.get('badge', '')
        if badge:
            await session.async_set_variable('user.badge', badge)

        # Track session
        sid = session.session_id
        self.sessions[sid] = session

        return {
            'ok': True,
            'terminalId': sid,
            'title': title or sid,
        }

    async def _close(self, cmd):
        """Close a terminal session."""
        terminal_id = cmd.get('terminalId', '')
        session = self.sessions.get(terminal_id)
        if not session:
            return {'ok': False, 'error': f'Session not found: {terminal_id}'}

        try:
            await session.async_close()
        except Exception:
            pass  # Session may already be closed

        del self.sessions[terminal_id]
        return {'ok': True}

    async def _send(self, cmd):
        """Send text/command to a terminal session."""
        terminal_id = cmd.get('terminalId', '')
        command = cmd.get('command', '')
        session = self.sessions.get(terminal_id)
        if not session:
            return {'ok': False, 'error': f'Session not found: {terminal_id}'}

        await session.async_send_text(command + '\n')
        return {'ok': True}

    async def _read(self, cmd):
        """Read output from a terminal session."""
        terminal_id = cmd.get('terminalId', '')
        lines = cmd.get('lines', 50)
        raw = cmd.get('raw', False)
        session = self.sessions.get(terminal_id)
        if not session:
            return {'ok': False, 'error': f'Session not found: {terminal_id}'}

        contents = await session.async_get_contents(0, lines)
        text_lines = [line.string for line in contents]
        output = '\n'.join(text_lines)

        if not raw:
            output = strip_ansi(output)

        return {'ok': True, 'output': output}

    async def _list(self, cmd):
        """List all tracked sessions."""
        result = []
        for sid, session in list(self.sessions.items()):
            try:
                name = await session.async_get_variable('session.name')
                result.append({
                    'terminalId': sid,
                    'title': name or sid,
                    'alive': True,
                })
            except Exception:
                result.append({
                    'terminalId': sid,
                    'title': sid,
                    'alive': False,
                })

        return {'ok': True, 'sessions': result}

    async def _detect(self, cmd):
        """Detect the state of a Claude Code session."""
        terminal_id = cmd.get('terminalId', '')
        lines = cmd.get('lines', 20)
        session = self.sessions.get(terminal_id)
        if not session:
            return {'ok': False, 'error': f'Session not found: {terminal_id}'}

        contents = await session.async_get_contents(0, lines)
        text = '\n'.join(line.string for line in contents)
        state_info = detect_state(text)

        return {'ok': True, **state_info}

    async def _badge(self, cmd):
        """Set badge text on a terminal session."""
        terminal_id = cmd.get('terminalId', '')
        badge_text = cmd.get('text', '')
        session = self.sessions.get(terminal_id)
        if not session:
            return {'ok': False, 'error': f'Session not found: {terminal_id}'}

        await session.async_set_variable('user.badge', badge_text)
        return {'ok': True}

    async def run(self, connection):
        """Main loop: read JSON commands from stdin, write JSON responses to stdout."""
        self.connection = connection

        # Signal ready
        print(json.dumps({'ok': True, 'ready': True}), flush=True)

        # Read commands from stdin asynchronously
        loop = asyncio.get_event_loop()
        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: protocol, sys.stdin)

        while True:
            line = await reader.readline()
            if not line:
                break  # stdin closed

            line = line.decode('utf-8').strip()
            if not line:
                continue

            try:
                cmd = json.loads(line)
            except json.JSONDecodeError as e:
                print(json.dumps({
                    'ok': False,
                    'error': f'Invalid JSON: {e}',
                    'id': ''
                }), flush=True)
                continue

            req_id = cmd.get('id', '')
            result = await self.handle_command(cmd)
            result['id'] = req_id
            print(json.dumps(result), flush=True)


async def main(connection):
    bridge = ITerm2Bridge()
    await bridge.run(connection)


if __name__ == '__main__':
    # Check if running in standalone mode (for testing)
    if '--standalone' in sys.argv:
        # Standalone mode: process stdin/stdout without iTerm2 connection
        # Useful for testing the protocol
        print(json.dumps({'ok': True, 'ready': True, 'mode': 'standalone'}), flush=True)
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
                req_id = cmd.get('id', '')
                action = cmd.get('action', '')
                if action == 'ping':
                    print(json.dumps({'id': req_id, 'ok': True, 'pong': True}), flush=True)
                elif action == 'detect_text':
                    # Allow testing detect without iTerm2
                    text = cmd.get('text', '')
                    result = detect_state(text)
                    print(json.dumps({'id': req_id, 'ok': True, **result}), flush=True)
                else:
                    print(json.dumps({
                        'id': req_id, 'ok': False,
                        'error': 'Standalone mode: only ping and detect_text supported'
                    }), flush=True)
            except json.JSONDecodeError as e:
                print(json.dumps({'ok': False, 'error': str(e)}), flush=True)
    else:
        try:
            import iterm2
            iterm2.run_until_complete(main)
        except ImportError:
            print(json.dumps({
                'ok': False,
                'error': 'iterm2 package not installed. Run: pip3 install iterm2'
            }), flush=True)
            sys.exit(1)
        except Exception as e:
            print(json.dumps({
                'ok': False,
                'error': f'Failed to connect to iTerm2: {e}'
            }), flush=True)
            sys.exit(1)
