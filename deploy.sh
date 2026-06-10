#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  InvestySignals — Automated Deploy Script
#  Usage: bash deploy.sh
# ═══════════════════════════════════════════════════════════════

set -e  # exit on error

# ── Colors ──────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✅ $1${NC}"; }
info() { echo -e "${CYAN}ℹ  $1${NC}"; }
warn() { echo -e "${YELLOW}⚠  $1${NC}"; }
err()  { echo -e "${RED}❌ $1${NC}"; exit 1; }
head() { echo -e "\n${BOLD}${CYAN}── $1 ──────────────────────────────────${NC}"; }

# ── Config ──────────────────────────────────────────────────────
APP_DIR="/var/www/investysignals"
APP_NAME="investysignals"
NGINX_CONF="/etc/nginx/sites-available/${APP_NAME}"

echo -e "${BOLD}"
echo "╔══════════════════════════════════════════╗"
echo "║     InvestySignals — Deploy Script       ║"
echo "║         investysignals.store             ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

# ── Detect: first install or update? ────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  echo -e "${YELLOW}Existing install detected.${NC}"
  echo "1) Update (git pull + restart)"
  echo "2) Full re-install"
  read -p "Choose [1/2]: " INSTALL_MODE
else
  INSTALL_MODE="2"
fi

# ════════════════════════════════════════════════════════════════
#  UPDATE MODE  (option 1)
# ════════════════════════════════════════════════════════════════
if [ "$INSTALL_MODE" = "1" ]; then
  head "Updating App"
  cd "$APP_DIR"

  info "Pulling latest from GitHub..."
  git pull origin main
  ok "Code updated"

  info "Installing dependencies..."
  npm install --production
  ok "Dependencies ready"

  info "Restarting PM2..."
  pm2 restart "$APP_NAME"
  ok "App restarted"

  echo ""
  ok "Update complete! Live at https://investysignals.store"
  pm2 logs "$APP_NAME" --lines 20 --nostream
  exit 0
fi

# ════════════════════════════════════════════════════════════════
#  FULL INSTALL MODE  (option 2)
# ════════════════════════════════════════════════════════════════

# ── Collect config ──────────────────────────────────────────────
head "Configuration"

read -p "GitHub repo URL (SSH): " GITHUB_REPO
# example: git@github.com:shehan/investysignals.git

read -p "Domain (e.g. investysignals.store): " DOMAIN

read -p "MongoDB URI: " MONGO_URI
read -p "Groq API Key: " GROQ_KEY
read -p "JWT Secret (press Enter to auto-generate): " JWT_SEC
if [ -z "$JWT_SEC" ]; then
  JWT_SEC=$(openssl rand -hex 32)
  info "JWT Secret auto-generated"
fi

echo ""
warn "Starting full install. This takes ~3 minutes."
read -p "Continue? [y/N]: " CONFIRM
[ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ] && exit 0

# ── Step 1: System packages ─────────────────────────────────────
head "Step 1/9 — System Packages"
apt update -qq
apt install -y -qq curl git unzip nginx certbot python3-certbot-nginx
ok "System packages installed"

# ── Step 2: Node.js 20 ──────────────────────────────────────────
head "Step 2/9 — Node.js 20"
if ! command -v node &>/dev/null || [[ $(node -v) != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt install -y -qq nodejs
fi
ok "Node.js $(node -v) ready"

# ── Step 3: PM2 ─────────────────────────────────────────────────
head "Step 3/9 — PM2"
npm install -g pm2 --silent
ok "PM2 $(pm2 -v) ready"

# ── Step 4: GitHub SSH Key ───────────────────────────────────────
head "Step 4/9 — GitHub SSH Key"
if [ ! -f ~/.ssh/github_deploy ]; then
  ssh-keygen -t ed25519 -C "vps@${DOMAIN}" -f ~/.ssh/github_deploy -N "" > /dev/null 2>&1
  cat >> ~/.ssh/config << SSHEOF

Host github.com
  IdentityFile ~/.ssh/github_deploy
  StrictHostKeyChecking no
SSHEOF
  ok "SSH key generated"
else
  ok "SSH key already exists"
fi

echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}GitHub Deploy Key — Add this to your repo:${NC}"
echo -e "${YELLOW}GitHub → Repo → Settings → Deploy Keys → Add${NC}"
echo ""
cat ~/.ssh/github_deploy.pub
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
read -p "Key added to GitHub? [y to continue]: " KEY_ADDED
[ "$KEY_ADDED" != "y" ] && [ "$KEY_ADDED" != "Y" ] && err "Add the key first then re-run"

# Verify GitHub connection
ssh -T git@github.com 2>&1 | grep -q "success" || \
  ssh -T git@github.com 2>&1 | grep -qi "authenticated" || \
  warn "Could not verify GitHub connection — continuing anyway"

# ── Step 5: Clone Repository ─────────────────────────────────────
head "Step 5/9 — Clone Repository"
if [ -d "$APP_DIR" ]; then
  warn "Removing old install..."
  pm2 delete "$APP_NAME" 2>/dev/null || true
  rm -rf "$APP_DIR"
fi

mkdir -p /var/www
git clone "$GITHUB_REPO" "$APP_DIR"
ok "Repository cloned to $APP_DIR"

# ── Step 6: Environment File ─────────────────────────────────────
head "Step 6/9 — Environment File"
cat > "$APP_DIR/.env" << ENVEOF
PORT=2000
MONGODB_URI=${MONGO_URI}
GROQ_API_KEY=${GROQ_KEY}
JWT_SECRET=${JWT_SEC}
NODE_ENV=production
ENVEOF
chmod 600 "$APP_DIR/.env"
ok ".env created (600 permissions)"

# ── Step 7: Install Dependencies ────────────────────────────────
head "Step 7/9 — Dependencies"
cd "$APP_DIR"
npm install --production
ok "npm packages installed"

# ── Step 8: Nginx ────────────────────────────────────────────────
head "Step 8/9 — Nginx"

# Use project nginx.conf if it exists and has SSL block
# Otherwise write a basic proxy config
if grep -q "ssl_certificate" "$APP_DIR/nginx.conf" 2>/dev/null; then
  info "Using project nginx.conf (has SSL)"
  cp "$APP_DIR/nginx.conf" "$NGINX_CONF"
else
  info "Writing basic nginx config (run certbot after to add SSL)"
  cat > "$NGINX_CONF" << NGINXEOF
server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN};

    gzip on;
    gzip_types text/plain text/css application/javascript application/json;

    location / {
        proxy_pass         http://127.0.0.1:2000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400s;
    }
}
NGINXEOF
fi

ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
ok "Nginx configured"

# ── SSL ──────────────────────────────────────────────────────────
read -p "Domain DNS pointed to this server? Get SSL now? [y/N]: " DO_SSL
if [ "$DO_SSL" = "y" ] || [ "$DO_SSL" = "Y" ]; then
  certbot --nginx -d "$DOMAIN" -d "www.${DOMAIN}" --non-interactive --agree-tos -m "admin@${DOMAIN}"
  ok "SSL certificate installed"
else
  warn "Skipped SSL. Run later: certbot --nginx -d ${DOMAIN} -d www.${DOMAIN}"
fi

# ── Step 9: PM2 Start ────────────────────────────────────────────
head "Step 9/9 — PM2 Start"
cd "$APP_DIR"
pm2 delete "$APP_NAME" 2>/dev/null || true
pm2 start server.js --name "$APP_NAME"
pm2 save

# Setup auto-start on reboot
PM2_STARTUP=$(pm2 startup 2>&1 | grep "sudo env" | tail -1)
if [ -n "$PM2_STARTUP" ]; then
  eval "$PM2_STARTUP"
  ok "PM2 auto-start configured"
fi

# ── Firewall ─────────────────────────────────────────────────────
ufw allow ssh > /dev/null 2>&1
ufw allow 80  > /dev/null 2>&1
ufw allow 443 > /dev/null 2>&1
ufw --force enable > /dev/null 2>&1
ok "Firewall configured"

# ── Done ─────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}"
echo "╔══════════════════════════════════════════╗"
echo "║       Deploy Complete! 🚀                ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"
pm2 status
echo ""
info "App URL: https://${DOMAIN}"
info "API check: https://${DOMAIN}/api/version"
echo ""
info "Future updates: cd ${APP_DIR} && git pull && npm install --production && pm2 restart ${APP_NAME}"
echo ""
pm2 logs "$APP_NAME" --lines 15 --nostream
