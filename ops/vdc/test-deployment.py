"""Regression checks for the deployment's privilege and configuration boundaries."""

import copy
import importlib.util
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

import yaml

OPS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "socket_mount", OPS / "set-nginx-socket.py"
)
socket_mount = importlib.util.module_from_spec(spec)
spec.loader.exec_module(socket_mount)


class Deployment(unittest.TestCase):
    def test_updates_roll_back_code_without_replacing_database(self):
        for name, rollback, new_files in (
            (
                "update-completion.sh",
                "rollback_code",
                ("src/request-id.ts", "server/request-id.test.ts"),
            ),
            (
                "update-uiux.sh",
                "rollback_ui",
                ("src/task-view.ts", "server/task-view.test.ts"),
            ),
            ("update-project-delete.sh", "rollback_code", ()),
        ):
            self.check_update_rollback(name, rollback, new_files)

    def check_update_rollback(self, name, rollback, new_files):
        script = (OPS / name).read_text()
        handler = script[
            script.index(rollback + "() {") : script.index("trap on_error ERR")
            + len("trap on_error ERR")
        ]
        for changed in (False, True):
            with (
                self.subTest(script=name, changed=changed),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                live, old, backup = root / "live", root / "old", root / "backup"
                for folder in (live, old):
                    (folder / "src").mkdir(parents=True)
                    (folder / "server").mkdir()
                    (folder / "dist").mkdir()
                    (folder / "src/App.tsx").write_text(
                        "new" if folder == live else "old"
                    )
                    (folder / "dist/index.html").write_text(
                        "new" if folder == live else "old"
                    )
                for added in new_files:
                    (live / added).write_text("new file")
                (live / "dist/new.js").write_text("new asset")
                (live / "tasks.sqlite").write_bytes(b"current database")
                backup.mkdir()
                archive_name = (
                    "ui.tar.gz" if name == "update-uiux.sh" else "code.tar.gz"
                )
                with tarfile.open(backup / archive_name, "w:gz") as archive:
                    archive.add(old / "src/App.tsx", arcname="src/App.tsx")
                    archive.add(old / "dist", arcname="dist")
                result = subprocess.run(
                    [
                        "bash",
                        "-c",
                        "\n".join(
                            [
                                "set -euo pipefail",
                                f"VDC_CHANGED={'true' if changed else 'false'}",
                                "VDC_PHASE=fixture",
                                f"VDC_BACKUP='{backup}'",
                                f"VDC_LOG='{root}/log'",
                                "services() { :; }",
                                f'as_vetvi() {{ (cd "{live}" && "$@"); }}',
                                handler.replace("/opt/vetvi", str(live)),
                                "false",
                            ]
                        ),
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("fixture", result.stderr)
                self.assertEqual(
                    (live / "tasks.sqlite").read_bytes(), b"current database"
                )
                self.assertEqual(
                    (live / "src/App.tsx").read_text(), "old" if changed else "new"
                )
                self.assertEqual(
                    (live / "dist/index.html").read_text(), "old" if changed else "new"
                )
                for added in new_files:
                    self.assertEqual((live / added).exists(), not changed)
                self.assertEqual(
                    (live / "dist/new.js").exists(),
                    name in ("update-uiux.sh", "update-project-delete.sh")
                    or not changed,
                )

    def test_preflight_error_reports_phase_without_rollback(self):
        script = (OPS / "apply-http.sh").read_text()
        handler = script[
            script.index("on_error() {") : script.index("trap on_error ERR")
            + len("trap on_error ERR")
        ]
        result = subprocess.run(
            [
                "bash",
                "-c",
                "set -euo pipefail\nVDC_CHANGED=false\nVDC_PHASE=fixture\n"
                + handler
                + "\nfalse\n",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("Ошибка этапа fixture", result.stderr)
        self.assertIn("строка", result.stderr)
        self.assertIn("код 1", result.stderr)
        self.assertNotIn("Восстанавливаю", result.stderr)

    def test_mount_preserves_other_services_and_private_file_ownership(self):
        config = {
            "services": {
                "nginx": {"image": "gateway:current", "networks": ["edge", "entry"]},
                "api": {"image": "api:current", "environment": {"VALUE": "${FILE}"}},
                "postgres": {"volumes": ["data:/var/lib/postgresql/data"]},
            },
            "volumes": {"data": {}},
            "secrets": {"app": {"file": "/protected/fixture"}},
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "compose.yaml"
            path.write_text(yaml.safe_dump(config))
            path.chmod(0o600)
            before = path.stat()
            self.assertTrue(socket_mount.attach(path))
            expected = copy.deepcopy(config)
            expected["services"]["nginx"]["volumes"] = [socket_mount.MOUNT]
            self.assertEqual(yaml.safe_load(path.read_text()), expected)
            self.assertEqual(path.stat().st_uid, before.st_uid)
            self.assertEqual(path.stat().st_gid, before.st_gid)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            saved = path.read_bytes()
            self.assertFalse(socket_mount.attach(path))
            self.assertEqual(path.read_bytes(), saved)

    def test_conflicting_mount_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "compose.yaml"
            path.write_text(
                yaml.safe_dump(
                    {
                        "services": {
                            "nginx": {
                                "volumes": [
                                    {
                                        "type": "bind",
                                        "source": "/other",
                                        "target": "/run/vetvi-proxy",
                                    },
                                ]
                            }
                        }
                    }
                )
            )
            path.chmod(0o600)
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                socket_mount.attach(path)
            self.assertEqual(path.read_bytes(), before)

    @unittest.skipIf(os.getuid() == 0, "Requires normal-user directory permissions")
    def test_tsx_needs_a_working_directory_readable_by_the_service_user(self):
        root = OPS.parents[1]
        loader = root / "node_modules/tsx/dist/loader.mjs"
        original_cwd = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            script = folder / "check.ts"
            script.write_text('const message: string = "OK"; console.log(message);')
            cwd = folder / "private"
            cwd.mkdir()
            command = ["/opt/node24/bin/node", "--import", str(loader), str(script)]
            try:
                os.chdir(cwd)
                cwd.chmod(0)
                failed = subprocess.run(
                    command, check=False, capture_output=True, text=True
                )
                self.assertNotEqual(failed.returncode, 0)
                self.assertIn("EACCES", failed.stderr)
                cwd.chmod(0o700)
                passed = subprocess.run(
                    command, check=False, capture_output=True, text=True
                )
                self.assertEqual(passed.returncode, 0, passed.stderr)
                self.assertEqual(passed.stdout.strip(), "OK")
            finally:
                cwd.chmod(0o700)
                os.chdir(original_cwd)


if __name__ == "__main__":
    unittest.main()
