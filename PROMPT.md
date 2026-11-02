# The Joya install prompt

Copy everything inside the box below into Claude Code (or any AI assistant that can run
commands on the machine where Mint OS should go). It installs Mint OS with
[Joya](https://github.com/a-maraghy/Joya), asking you only a few plain questions.

```text
Install Mint OS for me with Joya.

Joya is the Mint OS installer. Its home is https://github.com/a-maraghy/Joya and the
installer is https://raw.githubusercontent.com/a-maraghy/Joya/main/install.sh.
Mint OS itself comes from https://github.com/a-maraghy/MONI_AI_OS (Joya fetches it).

How to talk to me:
- I am not technical. Use short, friendly sentences and no jargon.
- Ask ONE question at a time and wait for my answer.
- Offer the answer in brackets as the default; Enter / "ok" takes it.

Questions to ask:
1. "Where should Mint OS run?"
   a) This computer -- just for you, opened in the browser here
   b) A cloud server -- reachable from anywhere, with HTTPS
   If I am not sure, explain the difference in one sentence and recommend (b) if I want
   to use it from my phone or share it, else (a).

If (a) THIS COMPUTER:
2. Check it can run here yourself (do not ask me): Linux (Ubuntu or Debian) with systemd.
   - On Windows: Mint OS goes inside Ubuntu on WSL. Walk me through it step by step:
     `wsl --install -d Ubuntu-24.04`, enable systemd ([boot] systemd=true in /etc/wsl.conf),
     `wsl --shutdown`, then continue inside Ubuntu.
   - On a Mac: say it is not supported on a Mac yet and offer the cloud server option.
3. "Which port should Mint OS use? [3000]" -- only ask if 3000 is already taken; otherwise use it.

If (b) A CLOUD SERVER:
2. "Are you already connected to the server (this terminal is on it)?" If not, help me
   connect with ssh. The server should be Ubuntu 24.04 (22.04 and Debian 12 also work).
3. "Do you have a domain name for Mint OS, like mint.yourcompany.com? [no]"
   - If yes: ask for it, then tell me to point it (an A record) at the server's IP
     address -- find the IP yourself -- and check with `dig +short <domain>` before
     going on. Then ask "Your email for certificate reminders? (optional)".
   - If no: explain that Mint OS will use the IP address and the browser will show a
     one-time warning about the certificate.

Then:
4. Show me a short summary (where, the address it will have) and ask "Shall I install it now? [yes]".
5. Run the installer with my answers so it does not ask again, for example:
     curl -fsSL https://raw.githubusercontent.com/a-maraghy/Joya/main/install.sh \
       | sudo JOYA_YES=1 JOYA_WHERE=local JOYA_PORT=3000 bash
     curl -fsSL https://raw.githubusercontent.com/a-maraghy/Joya/main/install.sh \
       | sudo JOYA_YES=1 JOYA_WHERE=cloud JOYA_DOMAIN=mint.example.com JOYA_EMAIL=me@example.com bash
     curl -fsSL https://raw.githubusercontent.com/a-maraghy/Joya/main/install.sh \
       | sudo JOYA_YES=1 JOYA_WHERE=cloud JOYA_DOMAIN= bash          (no domain: the IP address)
   It takes 5-10 minutes; tell me it is working, not the raw output.
6. If it stops, read /var/log/joya-install.log, explain the problem in plain words, fix
   what you safely can (DNS not pointing yet, port 80 closed in the cloud provider's
   firewall, a busy port) and run it again -- running it again is always safe.
7. When it finishes, give me the one-time setup link it printed and tell me:
   open it, choose a username and password, and scan the QR code with an authenticator
   app (Google Authenticator, Microsoft Authenticator, 1Password...).

Rules:
- Never ask me for passwords, tokens or API keys in this chat. The Claude credential for
  the agents is added later in the panel (its Guide page shows how).
- Do not change anything else on the machine beyond what the installer does, unless I agree.
```

## Without an AI assistant

Run the installer yourself; it asks the same questions:

```bash
curl -fsSL https://raw.githubusercontent.com/a-maraghy/Joya/main/install.sh | sudo bash
```
