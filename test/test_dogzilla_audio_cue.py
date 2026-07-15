from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT_DIR = Path(__file__).resolve().parents[1]
AUDIO_DIR = ROOT_DIR / "sidecars" / "dogzilla_audio_cue"

spec = importlib.util.spec_from_file_location("dogzilla_audio_cue_server", AUDIO_DIR / "server.py")
server = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = server
spec.loader.exec_module(server)


class FakeProcess:
    next_pid = 1000

    def __init__(self, running: bool = True):
        self.pid = FakeProcess.next_pid
        FakeProcess.next_pid += 1
        self.running = running
        self.terminated = False
        self.killed = False
        self.stderr = None
        self.returncode = None

    def poll(self):
        return None if self.running else self.returncode

    def terminate(self):
        self.terminated = True
        self.running = False
        self.returncode = -15

    def wait(self, timeout=None):
        self.running = False
        return self.returncode

    def kill(self):
        self.killed = True
        self.running = False
        self.returncode = -9


class DogzillaAudioCueTests(unittest.TestCase):
    def test_aplay_uses_configured_usb_pcm_device(self):
        command = server.build_play_command(
            "/usr/bin/aplay",
            Path("public/sounds/robot-bark-normal-103.wav"),
            "plughw:CARD=Device,DEV=0",
        )

        self.assertEqual(command[0], "/usr/bin/aplay")
        self.assertIn("-D", command)
        self.assertEqual(command[command.index("-D") + 1], "plughw:CARD=Device,DEV=0")

    def test_confirm_preempts_active_thinking_process(self):
        state = server.AudioState(Path("public/sounds"), "aplay", "plughw:CARD=Device,DEV=0")
        thinking_process = FakeProcess()
        bark_process = FakeProcess()
        state.active_processes.append(thinking_process)

        with (
            patch.object(server, "resolve_player", return_value="/usr/bin/aplay"),
            patch.object(Path, "exists", return_value=True),
            patch.object(server.subprocess, "Popen", return_value=bark_process),
            patch.object(server.time, "sleep", return_value=None),
        ):
            result = server.play_cue(state, "confirm")

        self.assertTrue(result["ok"])
        self.assertTrue(thinking_process.terminated)
        self.assertEqual(result["pid"], bark_process.pid)

    def test_bark_cue_uses_named_bark_files(self):
        state = server.AudioState(Path("public/sounds"), "aplay", "")
        thinking_process = FakeProcess()
        bark_process = FakeProcess()
        state.active_processes.append(thinking_process)

        with (
            patch.object(server, "resolve_player", return_value="/usr/bin/aplay"),
            patch.object(Path, "exists", return_value=True),
            patch.object(server.random, "choice", return_value="robot-bark-normal-103.wav"),
            patch.object(server.subprocess, "Popen", return_value=bark_process) as popen,
            patch.object(server.time, "sleep", return_value=None),
        ):
            result = server.play_cue(state, "bark")

        self.assertTrue(result["ok"])
        self.assertEqual(result["cue"], "bark")
        self.assertTrue(thinking_process.terminated)
        self.assertIn("robot-bark-normal-103.wav", str(popen.call_args.args[0][-1]))

    def test_mapping_start_cue_uses_supplied_sound(self):
        state = server.AudioState(Path("public/sounds"), "aplay", "")
        process = FakeProcess()

        with (
            patch.object(server, "resolve_player", return_value="/usr/bin/aplay"),
            patch.object(Path, "exists", return_value=True),
            patch.object(server.subprocess, "Popen", return_value=process) as popen,
            patch.object(server.time, "sleep", return_value=None),
        ):
            result = server.play_cue(state, "mapping-start")

        self.assertTrue(result["ok"])
        self.assertIn("mapping-start.wav", str(popen.call_args.args[0][-1]))

    def test_bark_cue_uses_scaled_temp_file_when_volume_is_lowered(self):
        state = server.AudioState(Path("public/sounds"), "aplay", "")
        bark_process = FakeProcess()
        scaled_file = Path("public/sounds/robodoge-audio-scaled.wav")

        with (
            patch.object(server, "resolve_player", return_value="/usr/bin/aplay"),
            patch.object(Path, "exists", return_value=True),
            patch.object(server.random, "choice", return_value="robot-bark-normal-103.wav"),
            patch.object(server, "prepare_playback_file", return_value=scaled_file) as prepare,
            patch.object(server.subprocess, "Popen", return_value=bark_process) as popen,
            patch.object(server.time, "sleep", return_value=None),
        ):
            result = server.play_cue(state, "bark", 0.4)

        self.assertTrue(result["ok"])
        self.assertEqual(result["volume"], 0.4)
        self.assertEqual(state.temp_files[bark_process.pid], scaled_file)
        self.assertEqual(prepare.call_args.args[2], 0.4)
        self.assertIn("robodoge-audio-scaled.wav", str(popen.call_args.args[0][-1]))

    def test_zero_volume_mutes_without_starting_player(self):
        state = server.AudioState(Path("public/sounds"), "aplay", "")
        thinking_process = FakeProcess()
        state.active_processes.append(thinking_process)

        with patch.object(server.subprocess, "Popen") as popen:
            result = server.play_cue(state, "bark", 0)

        self.assertTrue(result["ok"])
        self.assertTrue(result["muted"])
        self.assertEqual(result["volume"], 0.0)
        self.assertTrue(thinking_process.terminated)
        popen.assert_not_called()

    def test_cue_without_volume_uses_stored_volume(self):
        state = server.AudioState(Path("public/sounds"), "aplay", "", volume=0.2)
        bark_process = FakeProcess()
        scaled_file = Path("public/sounds/robodoge-audio-scaled.wav")

        with (
            patch.object(server, "resolve_player", return_value="/usr/bin/aplay"),
            patch.object(Path, "exists", return_value=True),
            patch.object(server.random, "choice", return_value="robot-bark-normal-103.wav"),
            patch.object(server, "prepare_playback_file", return_value=scaled_file),
            patch.object(server.subprocess, "Popen", return_value=bark_process) as popen,
            patch.object(server.time, "sleep", return_value=None),
        ):
            result = server.play_cue(state, "bark")

        self.assertTrue(result["ok"])
        self.assertEqual(result["volume"], 0.2)
        self.assertEqual(state.volume, 0.2)
        self.assertIn("robodoge-audio-scaled.wav", str(popen.call_args.args[0][-1]))

    def test_cue_updates_stored_volume(self):
        state = server.AudioState(Path("public/sounds"), "aplay", "")
        bark_process = FakeProcess()

        with (
            patch.object(server, "resolve_player", return_value="/usr/bin/aplay"),
            patch.object(Path, "exists", return_value=True),
            patch.object(server.random, "choice", return_value="robot-bark-normal-103.wav"),
            patch.object(server.subprocess, "Popen", return_value=bark_process),
            patch.object(server.time, "sleep", return_value=None),
        ):
            server.play_cue(state, "bark", 0.35)

        self.assertEqual(state.volume, 0.35)

    def test_default_volume_is_normalized(self):
        state = server.AudioState(Path("public/sounds"), "aplay", "", volume=50)
        self.assertEqual(state.volume, 0.5)


if __name__ == "__main__":
    unittest.main()
