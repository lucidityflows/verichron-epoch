"""Decrypts an encrypted iTunes-format backup into the same layout (EPOCH-489).

Usage: decrypt_backup.py <backup_dir> <dest_dir>
       decrypt_backup.py --version

The password comes only from the BACKUP_PASSWORD environment variable, never
the command line (R30). <dest_dir> must not exist or be empty. The result is
the layout iLEAPP reads with `-t itunes`: the decrypted Manifest.db, every
listed file at XX/<fileID>, and the backup's root .plist files.

Every file Manifest.db lists (flags=1) must be in the backup and decrypt; a
missing or failed file fails the run, so an incomplete decrypt is never
reported as complete. Exit codes:
  0  every listed file was written
  1  the decrypt failed (a missing or failed file, or another error)
  2  bad arguments or environment
  3  wrong password

Uses two internals of iphone_backup_decrypt (the unlocked keybag and the
chunked file decrypt), because its public calls look files up by path and
cannot copy entries that have no encryption key. The version is pinned
exactly in pyproject.toml for that reason.
"""

import importlib.metadata
import os
import shutil
import sys
import tempfile
import time
from typing import NoReturn

LIBRARY = "iphone_backup_decrypt"

# Exit codes, mirrored in apps/processor/src/utils/decrypt.ts.
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_WRONG_PASSWORD = 3

# How often a progress line is printed while files are written.
PROGRESS_SECONDS = 15
# How many failed files are named; the count is always complete.
NAMED_FAILURES = 10


def say(message: str) -> None:
    print(f"  decrypt-backup: {message}", flush=True)


def fail(code: int, message: str) -> NoReturn:
    print(f"  decrypt-backup: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


def root_plists(src: str) -> list[str]:
    """The .plist files at the backup's root (Info, Manifest, Status)."""
    return sorted(name for name in os.listdir(src) if name.endswith(".plist"))


def main() -> None:
    if sys.argv[1:] == ["--version"]:
        print(f"{LIBRARY} {importlib.metadata.version(LIBRARY)}")
        return
    if len(sys.argv) != 3:
        fail(EXIT_USAGE, "usage: decrypt_backup.py <backup_dir> <dest_dir>")
    src, dest = (os.path.abspath(p) for p in sys.argv[1:])
    password = os.environ.pop("BACKUP_PASSWORD", "")
    if not password:
        fail(EXIT_USAGE, "BACKUP_PASSWORD is not set")
    for name in ("Manifest.db", "Manifest.plist"):
        if not os.path.isfile(os.path.join(src, name)):
            fail(EXIT_USAGE, f"no {name} in {src}; not an iTunes-format backup")
    # The root plists are copied into the decrypt as they are, so each must be
    # a regular file of the backup itself: a link could bring in content from
    # outside it, and a directory would fail only after the files were written.
    for name in root_plists(src):
        path = os.path.join(src, name)
        if os.path.islink(path) or not os.path.isfile(path):
            fail(EXIT_USAGE, f"{path} is not a regular file in the backup")
    if os.path.exists(dest) and os.listdir(dest):
        fail(EXIT_USAGE, f"{dest} is not empty")
    os.makedirs(dest, exist_ok=True)

    # The library writes a decrypted copy of Manifest.db to a temporary
    # folder; keep it inside the destination rather than the system's /tmp.
    work = tempfile.mkdtemp(prefix=".decrypt-", dir=dest)
    tempfile.tempdir = work
    try:
        decrypt(src, dest, password)
    finally:
        tempfile.tempdir = None
        shutil.rmtree(work, ignore_errors=True)


def decrypt(src: str, dest: str, password: str) -> None:
    from iphone_backup_decrypt import EncryptedBackup, utils

    started = time.monotonic()
    backup = EncryptedBackup(backup_directory=src, passphrase=password)
    try:
        write_files(backup, utils, src, dest, started)
    finally:
        # Remove the library's decrypted Manifest.db copy now, while its
        # folder exists; its own deallocator would otherwise try again later.
        backup._cleanup()
        backup._cleanup = lambda: None


def write_files(backup, utils, src: str, dest: str, started: float) -> None:
    say("unlocking the backup's keys (this takes about a minute)")
    try:
        backup._read_and_unlock_keybag()
    except ValueError as err:
        if "incorrect passphrase" in str(err):
            fail(EXIT_WRONG_PASSWORD, "the password is wrong")
        raise
    say(f"keys unlocked in {time.monotonic() - started:.0f} s")
    backup.save_manifest_file(os.path.join(dest, "Manifest.db"))

    with backup.manifest_db_cursor() as cur:
        cur.execute("SELECT fileID, domain, relativePath, file FROM Files WHERE flags=1")
        rows = cur.fetchall()
    total = len(rows)
    say(f"{total} files listed in Manifest.db")

    missing: list[str] = []
    failed: list[str] = []
    size_differs = 0
    last = time.monotonic()
    for n, (file_id, domain, relative_path, file_bplist) in enumerate(rows, 1):
        listed = f"{domain}/{relative_path}"
        if len(file_id) != 40 or not all(c in "0123456789abcdef" for c in file_id):
            failed.append(f"{listed} (unexpected file ID {file_id!r})")
            continue
        source = utils.backup_file_path(src, file_id)
        target = os.path.join(dest, file_id[:2], file_id)
        if not os.path.isfile(source):
            missing.append(listed)
            continue
        try:
            plist = utils.FilePlist(file_bplist)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if plist.encryption_key is None:
                shutil.copy2(source, target)
                size = os.path.getsize(target)
            else:
                key = backup._keybag.unwrapKeyForClass(plist.protection_class, plist.encryption_key)
                size = utils.aes_decrypt_chunked(in_filename=source, out_filepath=target, key=key)
                if plist.mtime:
                    os.utime(target, times=(plist.mtime, plist.mtime))
            # iOS often records a size that differs from the file's for
            # databases written during the backup; counted, not a failure.
            if size != plist.filesize:
                size_differs += 1
        except Exception as err:  # every failure is counted and named; the run fails below
            failed.append(f"{listed} ({type(err).__name__}: {err})")
        if time.monotonic() - last >= PROGRESS_SECONDS:
            last = time.monotonic()
            say(f"{n} of {total} files")

    for name in root_plists(src):
        shutil.copy2(os.path.join(src, name), dest)

    elapsed = time.monotonic() - started
    if missing or failed:
        for label, items in (("missing from the backup", missing), ("could not be decrypted", failed)):
            if items:
                more = f", and {len(items) - NAMED_FAILURES} more" if len(items) > NAMED_FAILURES else ""
                say(f"{len(items)} file(s) {label}: {', '.join(items[:NAMED_FAILURES])}{more}")
        fail(
            EXIT_FAILED,
            f"incomplete: {total - len(missing) - len(failed)} of {total} files written "
            f"({len(missing)} missing, {len(failed)} failed) in {elapsed:.0f} s",
        )
    say(
        f"all {total} files written in {elapsed:.0f} s"
        + (f"; {size_differs} differ in size from Manifest.db's record" if size_differs else "")
    )


if __name__ == "__main__":
    main()
