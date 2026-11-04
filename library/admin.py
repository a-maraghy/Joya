#!/usr/bin/env python3
"""Studio accounts of the JOYA Library. Viewing needs no account; uploading and managing does.

  python3 library/admin.py user add <name>        create an account (asks for the password twice)
  python3 library/admin.py user passwd <name>     set a new password (signs that user out everywhere)
  python3 library/admin.py user disable <name>    stop an account from signing in (and sign it out)
  python3 library/admin.py user enable <name>
  python3 library/admin.py user list
  python3 library/admin.py sessions clear         sign everybody out

Passwords are typed at a hidden prompt, never on the command line, and stored as scrypt hashes.
Run it as root (or the joyalib user) so it can open the database.
"""
import getpass
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import joyalib as L  # noqa: E402
import server as S  # noqa: E402

NAME_RE = re.compile(r'^[a-z0-9][a-z0-9._-]{1,31}$')


def ask_password():
    for _ in range(3):
        pw = getpass.getpass('New password (at least 12 characters): ')
        if len(pw) < 12:
            print('Too short; use at least 12 characters (a few words work well).')
            continue
        if getpass.getpass('Type it again: ') != pw:
            print('The two did not match.')
            continue
        return pw
    raise SystemExit('no password set')


def main(argv):
    if len(argv) < 2:
        raise SystemExit(__doc__)
    S.init_db()
    L.chown(L.DB_PATH)
    c = S.db()
    what, cmd = argv[0], argv[1]
    if what == 'sessions' and cmd == 'clear':
        n = c.execute('DELETE FROM sessions').rowcount
        print('signed out %d session(s)' % n)
        return
    if what != 'user':
        raise SystemExit(__doc__)
    if cmd == 'list':
        for r in c.execute('SELECT name, created, last_login, disabled FROM users ORDER BY name'):
            last = time.strftime('%Y-%m-%d %H:%M', time.localtime(r['last_login'])) if r['last_login'] else 'never'
            print('%-24s %s  last sign-in %s' % (r['name'], 'disabled' if r['disabled'] else 'active  ', last))
        return
    if len(argv) < 3:
        raise SystemExit(__doc__)
    name = argv[2].strip().lower()
    row = c.execute('SELECT * FROM users WHERE name = ?', (name,)).fetchone()
    if cmd == 'add':
        if not NAME_RE.match(name):
            raise SystemExit('use 2-32 lowercase letters, digits, dots, dashes or underscores')
        if row:
            raise SystemExit('%s already exists; use passwd to change the password' % name)
        pw = ask_password()
        c.execute('INSERT INTO users (name, pw, created) VALUES (?,?,?)', (name, S.hash_password(pw), int(time.time())))
        print('created %s. Sign in at %s/studio/' % (name, L.BASE_URL))
    elif cmd == 'passwd':
        if not row:
            raise SystemExit('no user %s' % name)
        pw = ask_password()
        c.execute('UPDATE users SET pw = ? WHERE id = ?', (S.hash_password(pw), row['id']))
        c.execute('DELETE FROM sessions WHERE user_id = ?', (row['id'],))
        print('password changed for %s' % name)
    elif cmd in ('disable', 'enable'):
        if not row:
            raise SystemExit('no user %s' % name)
        c.execute('UPDATE users SET disabled = ? WHERE id = ?', (1 if cmd == 'disable' else 0, row['id']))
        if cmd == 'disable':
            c.execute('DELETE FROM sessions WHERE user_id = ?', (row['id'],))
        print('%sd %s' % (cmd, name))
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    finally:
        for suffix in ('', '-wal', '-shm'):  # the service user must keep owning the database files
            if os.path.exists(L.DB_PATH + suffix):
                L.chown(L.DB_PATH + suffix)
