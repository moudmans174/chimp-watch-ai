"""Administration commands.

Examples (inside Docker: docker compose exec api python -m app.manage ...):
  python -m app.manage create-admin --email you@example.org --name "Your Name"
  python -m app.manage reset-password --email someone@example.org
  python -m app.manage list-users
  python -m app.manage test-email --to you@example.org
  python -m app.manage run-assessment
"""
import argparse
import getpass
import sys

from sqlalchemy import func, select

from .db import SessionLocal
from .models import Organisation, Role, User
from .security import hash_password


def _password(given: str | None) -> str:
    if given:
        return given
    while True:
        p1 = getpass.getpass("New password: ")
        p2 = getpass.getpass("Repeat password: ")
        if p1 != p2:
            print("Passwords don't match, try again.")
        elif len(p1) < 10 or p1.isalpha() or p1.isdigit():
            print("Use at least 10 characters, mixing letters with numbers or symbols.")
        else:
            return p1


def create_admin(a):
    with SessionLocal() as db:
        org = db.scalar(select(Organisation).where(Organisation.name == a.org)) if a.org else None
        if a.org and not org:
            org = Organisation(name=a.org, kind="government")
            db.add(org)
            db.flush()
        org = org or db.scalar(select(Organisation).where(Organisation.kind != "pending").order_by(Organisation.id))
        if not org:
            org = Organisation(name="Platform administration", kind="government")
            db.add(org)
            db.flush()
        u = db.scalar(select(User).where(func.lower(User.email) == a.email.lower()))
        created = u is None
        if created:
            u = User(email=a.email.lower(), full_name=a.name or a.email.split("@")[0], org_id=org.id)
            db.add(u)
        u.hashed_password = hash_password(_password(a.password))
        u.role, u.is_active, u.pending_approval, u.can_view_sensitive = Role.admin, True, False, True
        u.failed_logins, u.locked_until = 0, None
        db.commit()
        print(f"{'Created' if created else 'Updated'} administrator {u.email} ({org.name}).")


def reset_password(a):
    with SessionLocal() as db:
        u = db.scalar(select(User).where(func.lower(User.email) == a.email.lower()))
        if not u:
            sys.exit(f"No user with email {a.email}")
        u.hashed_password = hash_password(_password(a.password))
        u.failed_logins, u.locked_until = 0, None
        if a.activate:
            u.is_active, u.pending_approval = True, False
        db.commit()
        print(f"Password reset for {u.email}. Account {'active' if u.is_active else 'INACTIVE'}.")


def list_users(_a):
    with SessionLocal() as db:
        for u in db.scalars(select(User).order_by(User.email)):
            state = "pending" if u.pending_approval else "active" if u.is_active else "inactive"
            print(f"{u.email:40} {u.role.value:14} {state:9} {u.org.name if u.org else ''}")


def test_email(a):
    from .services import mailer
    mailer.send(a.to, "Test email", ["This is a test message from your CHIMP-WATCH AI installation.",
                                     "If you can read this, outgoing email is working."], background=False)
    print("Sent via SMTP." if mailer.configured() else "SMTP not configured: the message was written to the log.")


def run_assessment(_a):
    from .services import risk
    with SessionLocal() as db:
        print(risk.run_all(db))


def main():
    p = argparse.ArgumentParser(prog="python -m app.manage")
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-admin", help="Create or update an administrator account")
    c.add_argument("--email", required=True)
    c.add_argument("--name")
    c.add_argument("--org", help="Organisation name (created if missing)")
    c.add_argument("--password", help="Omit to be prompted (recommended)")
    c.set_defaults(fn=create_admin)
    r = sub.add_parser("reset-password", help="Set a new password and unlock an account")
    r.add_argument("--email", required=True)
    r.add_argument("--password", help="Omit to be prompted (recommended)")
    r.add_argument("--activate", action="store_true", help="Also activate the account")
    r.set_defaults(fn=reset_password)
    sub.add_parser("list-users", help="List accounts").set_defaults(fn=list_users)
    t = sub.add_parser("test-email", help="Send a test email")
    t.add_argument("--to", required=True)
    t.set_defaults(fn=test_email)
    sub.add_parser("run-assessment", help="Recompute all risk assessments now").set_defaults(fn=run_assessment)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
