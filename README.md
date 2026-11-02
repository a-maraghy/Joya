# Joya

**The fast way to install [Mint OS](https://github.com/a-maraghy/MONI_AI_OS)**, the web
control panel for your own team of Claude agents. One command, a few plain questions,
and Mint OS is running in about 5-10 minutes.

## Install

On the machine where Mint OS should run (Ubuntu 24.04 recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/a-maraghy/Joya/main/install.sh | sudo bash
```

Or let an AI assistant do it for you: copy the prompt in **[PROMPT.md](PROMPT.md)** into
Claude Code and answer its questions.

## What it asks

**Where are you installing Mint OS?**

| | This computer | A cloud server |
|---|---|---|
| For | just you, in the browser on this machine | using it from anywhere, phone included |
| Asks | the port (`3000`) | your domain (or none, to use the IP address), an email for certificate reminders |
| Address | `http://localhost:3000` | `https://your-domain` |
| HTTPS | not needed (it never leaves this computer) | free Let's Encrypt certificate; a self-made one when there is no domain |

Then it shows a short summary and asks **Install now?**. At the end it prints a one-time
link where you create your admin account (username, password and an authenticator-app
code).

## What it does

1. Installs the basics (git, Node.js, Python) and fetches Mint OS into `/opt/moni-ai-os`.
2. Sets up the agent stack: a service account, the agent runtime, local memory search.
3. Starts the panel as a system service that comes back after a restart.
4. Cloud only: nginx with HTTPS, a redirect from HTTP, rate-limited sign-in, fail2ban,
   and the firewall opened for ports 80 and 443 if `ufw` is on.

Run it again any time: it updates Mint OS and keeps your data and answers.

## Answering ahead of time

Every question can be given up front, for scripts and AI assistants:

```bash
curl -fsSL https://raw.githubusercontent.com/a-maraghy/Joya/main/install.sh \
  | sudo JOYA_YES=1 JOYA_WHERE=cloud JOYA_DOMAIN=mint.example.com JOYA_EMAIL=me@example.com bash
```

| Variable | Meaning |
|---|---|
| `JOYA_WHERE` | `local` (this computer) or `cloud` (a cloud server) |
| `JOYA_PORT` | local: the panel's port (default 3000) |
| `JOYA_DOMAIN` | cloud: the domain; empty = the server's IP address |
| `JOYA_EMAIL` | cloud: email for certificate reminders (optional) |
| `JOYA_YES=1` | skip the final "Install now?" |
| `JOYA_REPO`, `JOYA_REF`, `JOYA_DIR` | advanced: another Mint OS fork, branch or folder |
| `JOYA_HTTPS_PORT` | advanced, cloud: HTTPS on another port than 443 |

## Windows

Mint OS runs inside Ubuntu on WSL:

1. In PowerShell: `wsl --install -d Ubuntu-24.04`, then open Ubuntu.
2. Turn systemd on: `printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf`, then in
   PowerShell `wsl --shutdown`, and open Ubuntu again.
3. Run the install command above, choose **This computer**, and open
   `http://localhost:3000` in your Windows browser.

macOS is not supported on the computer itself yet; install it on a cloud server instead.

## Good to know

- **Only this computer can open it** in the local install: the panel listens on
  `127.0.0.1` alone, so nothing on your network can reach it.
- **Agents need a Claude credential** (a Claude subscription token or an API key). You
  add it after installing; the panel's **Guide** page walks you through it.
- **The agent runtime is a separate repository.** If this machine has no access to it,
  Joya still installs the panel and tells you; run Joya again once access is granted.
- **Log:** `/var/log/joya-install.log`. **Your answers:** `/etc/joya/answers.env`.

## License

The installer is provided as is. Mint OS has its own terms in its repository.
