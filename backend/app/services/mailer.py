"""Outgoing email.

Uses SMTP when CW_SMTP_HOST is set (works with any provider: Gmail/Google Workspace, Microsoft 365,
SendGrid, Mailgun, Amazon SES, or an organisation's own mail server). Without it, messages are written
to the application log so nothing is lost during development, and kept in `outbox` for tests.
"""
from __future__ import annotations

import html
import logging
import smtplib
import ssl
import threading
from dataclasses import dataclass, field
from email.message import EmailMessage

from ..config import get_settings

log = logging.getLogger("chimpwatch.mail")


@dataclass
class Sent:
    to: list[str]
    subject: str
    text: str
    links: list[str] = field(default_factory=list)


outbox: list[Sent] = []  # in-memory record (tests, console mode)


def configured() -> bool:
    return bool(get_settings().smtp_host)


def _html(subject: str, paragraphs: list[str], action: tuple[str, str] | None) -> str:
    e = html.escape
    body = "".join(f"<p style='margin:0 0 14px'>{e(p)}</p>" for p in paragraphs)
    button = ""
    if action:
        label, url = action
        button = (f"<p style='margin:22px 0'><a href='{e(url)}' style='background:#1e6b75;color:#fff;padding:12px 20px;"
                  f"border-radius:8px;text-decoration:none;font-weight:600;display:inline-block'>{e(label)}</a></p>"
                  f"<p style='font-size:12px;color:#6e7f77'>Or paste this link into your browser:<br>{e(url)}</p>")
    return f"""<!doctype html><html><body style="margin:0;background:#eef1ea;font-family:Arial,Helvetica,sans-serif;color:#14281f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#10231b;padding:18px 24px;color:#fff;font-weight:700;letter-spacing:.02em">CHIMP-WATCH AI</td></tr>
<tr><td style="padding:26px 24px 10px;font-size:15px;line-height:1.55"><h1 style="font-size:19px;margin:0 0 16px">{e(subject)}</h1>{body}{button}</td></tr>
<tr><td style="padding:14px 24px 22px;font-size:12px;color:#6e7f77;border-top:1px solid #e6ece3">You received this because you have an account on the CHIMP-WATCH AI conservation platform. Chimpanzee locations are never included in email.</td></tr>
</table></td></tr></table></body></html>"""


def _deliver(msg: EmailMessage) -> None:
    s = get_settings()
    try:
        if s.smtp_port == 465:
            with smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, context=ssl.create_default_context(), timeout=20) as smtp:
                if s.smtp_user:
                    smtp.login(s.smtp_user, s.smtp_password or "")
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=20) as smtp:
                if s.smtp_starttls:
                    smtp.starttls(context=ssl.create_default_context())
                if s.smtp_user:
                    smtp.login(s.smtp_user, s.smtp_password or "")
                smtp.send_message(msg)
        log.info("email sent to %s: %s", msg["To"], msg["Subject"])
    except Exception as exc:  # email failure must never break the request that triggered it
        log.error("email to %s failed: %s", msg["To"], exc)


def send(to: list[str] | str, subject: str, paragraphs: list[str], action: tuple[str, str] | None = None,
         background: bool = True) -> None:
    recipients = [to] if isinstance(to, str) else [t for t in to if t]
    if not recipients:
        return
    text = "\n\n".join(paragraphs) + (f"\n\n{action[0]}: {action[1]}" if action else "")
    outbox.append(Sent(recipients, subject, text, [action[1]] if action else []))
    del outbox[:-200]
    s = get_settings()
    if not s.smtp_host:
        log.info("[email not configured] to=%s subject=%s\n%s", ", ".join(recipients), subject, text)
        return
    for rcpt in recipients:  # one message per recipient so addresses aren't disclosed to each other
        msg = EmailMessage()
        msg["From"] = s.smtp_from
        msg["To"] = rcpt
        msg["Subject"] = f"CHIMP-WATCH AI: {subject}"
        msg.set_content(text)
        msg.add_alternative(_html(subject, paragraphs, action), subtype="html")
        if background:
            threading.Thread(target=_deliver, args=(msg,), daemon=True).start()
        else:
            _deliver(msg)
