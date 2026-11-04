"""Add only the Vetvi socket mount to an existing operator Compose file."""

import os
import stat
import sys
import tempfile
from pathlib import Path

import yaml

MOUNT = {
    "type": "bind",
    "source": "/run/vetvi-proxy",
    "target": "/run/vetvi-proxy",
    "read_only": True,
    "bind": {"create_host_path": False},
}


def attach(path):
    path = Path(path)
    if path.is_symlink() or path != path.resolve():
        raise ValueError("Compose path must be canonical and not a symlink")
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise ValueError("Compose must be a private regular file with mode 600")
    config = yaml.safe_load(path.read_text())
    gateway = config["services"]["nginx"]
    mounts = gateway.setdefault("volumes", [])
    for mount in mounts:
        if not isinstance(mount, dict):
            raise TypeError("Review existing short-form gateway mounts first")
        if mount.get("target") == MOUNT["target"]:
            if mount != MOUNT:
                raise ValueError("Existing Vetvi mount differs; refusing replacement")
            return False
    mounts.append(MOUNT)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", dir=path.parent, delete=False
        ) as output:
            temporary = Path(output.name)
            os.fchmod(output.fileno(), 0o600)
            os.fchown(output.fileno(), metadata.st_uid, metadata.st_gid)
            yaml.safe_dump(config, output, sort_keys=False)
        os.replace(temporary, path)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    return True


if __name__ == "__main__":
    print(
        "Vetvi socket mount added"
        if attach(sys.argv[1])
        else "Vetvi socket mount already present"
    )
