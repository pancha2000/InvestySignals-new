#!/bin/bash
# ================================================================
#  InvestySignals — Deploy Script
#
#  INSTALL:   sudo bash deploy.sh install
#  UPDATE:    sudo bash deploy.sh update
#  STATUS:    sudo bash deploy.sh status
#  LOGS:      sudo bash deploy.sh logs
#  RESTART:   sudo bash deploy.sh restart
# ================================================================

set -e

# ── Config ───────────────────────────────────────────────────
REPO_URL="https://github.com/pancha2000/InvestySignals-new.git"
APP_DIR="/var/www/investysignals"
APP_NAME="investysignals"
NODE_VERSION="20"

# ── Colors ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log()     { echo -e "${GREEN}[✓]${NC} $1"; }
warn()    { echo -e "${YELLOW}[!]${NC} $1"; }
error()   { echo -e "${RED}[✗] ERROR: $1${NC}"; exit 1; }
info()    { echo -e "${CYAN}[→]${NC} $1"; }
section() {
  echo ""
  echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
  printf "${BLUE}║  %-40s║${NC}\n" "$1"
  echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
}

check_root() {
  [ "$EUID" -eq 0 ] || error "Root access required. Run: sudo bash deploy.sh $1"
}

# ================================================================
#  INSTALL
# ================================================================
cmd_install() {
  check_root install
  section "InvestySignals - Fresh VPS Install"

  # ── 1. System Packages ──────────────────────────────────────
  section "Step 1/7 - System Packages"
  apt-get update -qq
  apt-get install -y curl gnupg git unzip software-properties-common \
                     ca-certificates lsb-release ufw nginx
  log "System packages ready"

  # ── 2. Node.js ──────────────────────────────────────────────
  section "Step 2/7 - Node.js ${NODE_VERSION}"
  if command -v node &>/dev/null && \
     [ "$(node -v | sed 's/v//' | cut -d. -f1)" -ge "${NODE_VERSION}" ]; then
    log "Node.js $(node -v) already installed"
  else
    info "Installing Node.js ${NODE_VERSION}..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
    log "Node.js $(node -v) installed"
  fi

  # ── 3. MongoDB ──────────────────────────────────────────────
  section "Step 3/7 - MongoDB 7"
  if command -v mongod &>/dev/null; then
    log "MongoDB already installed"
  else
    info "Installing MongoDB 7..."
    # Ubuntu version detect කරලා correct repo use කරනවා
    UBUNTU_VER=$(lsb_release -rs)
    if [[ "$UBUNTU_VER" == "24.04" ]]; then
      # Ubuntu 24.04 (Noble) — MongoDB 8.0 use කරනවා
      curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
        | gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
      echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
        > /etc/apt/sources.list.d/mongodb-org-8.0.list
    else
      # Ubuntu 22.04 (Jammy) හා older — MongoDB 7.0
      curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc \
        | gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
      echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" \
        > /etc/apt/sources.list.d/mongodb-org-7.0.list
    fi
    apt-get update -qq
    apt-get install -y mongodb-org
    log "MongoDB installed"
  fi
  systemctl enable mongod
  systemctl start mongod
  sleep 2
  systemctl is-active --quiet mongod && log "MongoDB running" || error "MongoDB failed to start"

  # ── 4. PM2 ──────────────────────────────────────────────────
  section "Step 4/7 - PM2"
  command -v pm2 &>/dev/null && log "PM2 already installed" || { npm install -g pm2; log "PM2 installed"; }

  # ── 5. Clone Repo ───────────────────────────────────────────
  section "Step 5/7 - Clone Repository"
  if [ -d "$APP_DIR/.git" ]; then
    warn "$APP_DIR exists - pulling latest"
    cd "$APP_DIR" && git pull
  else
    git clone "$REPO_URL" "$APP_DIR"
    log "Repository cloned"
  fi

  # serviceAccount.json check
  if [ ! -f "$APP_DIR/serviceAccount.json" ]; then
    echo ""
    warn "serviceAccount.json NOT FOUND!"
    warn "ඔබේ computer හි run කරන්න:"
    warn "  scp serviceAccount.json root@$(hostname -I | awk '{print $1}'):${APP_DIR}/"
    warn ""
    read -p "Upload කළාද? (y/n): " SA_DONE
    [[ "$SA_DONE" =~ ^[Yy]$ ]] || error "serviceAccount.json required"
    [ -f "$APP_DIR/serviceAccount.json" ] || error "File not found at $APP_DIR/serviceAccount.json"
  fi
  log "serviceAccount.json found"

  # .env
  [ -f "$APP_DIR/.env" ] || cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  log ".env ready"

  # npm install
  cd "$APP_DIR"
  npm install --production
  log "npm packages installed"

  # ── 6. Nginx ────────────────────────────────────────────────
  section "Step 6/7 - Nginx"
  SERVER_IP=$(hostname -I | awk '{print $1}')
  cat > /etc/nginx/sites-available/investysignals << NGINXEOF
server {
    listen 80;
    server_name ${SERVER_IP} _;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }

    location ~* \.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2)\$ {
        proxy_pass http://127.0.0.1:3000;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
}
NGINXEOF

  ln -sf /etc/nginx/sites-available/investysignals /etc/nginx/sites-enabled/investysignals
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
  log "Nginx configured"

  # Firewall
  ufw allow OpenSSH      2>/dev/null || true
  ufw allow 'Nginx Full' 2>/dev/null || true
  ufw --force enable     2>/dev/null || true
  log "Firewall configured"

  # ── 7. Start App ────────────────────────────────────────────
  section "Step 7/7 - Start Application"
  cd "$APP_DIR"
  pm2 delete "$APP_NAME" 2>/dev/null || true
  pm2 start server.js --name "$APP_NAME" --restart-delay=3000 --max-restarts=10 --time
  pm2 save
  PM2_CMD=$(pm2 startup systemd -u root --hp /root 2>/dev/null | grep "sudo" | tail -1)
  [ -n "$PM2_CMD" ] && eval "$PM2_CMD" 2>/dev/null || true
  pm2 save
  log "App started with PM2"

  # ── Done ────────────────────────────────────────────────────
  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║    ✅  Installation Complete!        ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  🌐 Website : ${CYAN}http://${SERVER_IP}${NC}"
  echo -e "  📋 Logs    : sudo bash deploy.sh logs"
  echo -e "  📊 Status  : sudo bash deploy.sh status"
  echo ""
  echo -e "  ${YELLOW}Domain + SSL (optional):${NC}"
  echo -e "  ${YELLOW}  apt install certbot python3-certbot-nginx${NC}"
  echo -e "  ${YELLOW}  certbot --nginx -d yourdomain.com${NC}"
  echo ""
  pm2 status
}

# ================================================================
#  UPDATE
# ================================================================
cmd_update() {
  check_root update
  section "InvestySignals - Update"

  [ -d "$APP_DIR" ] || error "$APP_DIR not found. Run install first."

  # Backup secrets
  info "Backing up config files..."
  cp "$APP_DIR/.env"                /tmp/.investy_env_bak 2>/dev/null || true
  cp "$APP_DIR/serviceAccount.json" /tmp/.investy_sa_bak  2>/dev/null || true

  # Pull latest code
  info "Pulling from GitHub..."
  cd "$APP_DIR"
  git fetch origin
  git reset --hard origin/main
  log "Code updated"

  # Restore secrets
  cp /tmp/.investy_env_bak  "$APP_DIR/.env"                2>/dev/null || true
  cp /tmp/.investy_sa_bak   "$APP_DIR/serviceAccount.json" 2>/dev/null || true
  log "Config files preserved"

  # Update packages
  info "Updating npm packages..."
  npm install --production
  log "npm updated"

  # Restart
  info "Restarting..."
  pm2 restart "$APP_NAME" --update-env || \
    pm2 start server.js --name "$APP_NAME" --restart-delay=3000
  pm2 save

  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║       ✅  Update Complete!           ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
  echo ""
  pm2 status
}

# ================================================================
#  STATUS
# ================================================================
cmd_status() {
  section "InvestySignals - Status"
  echo -e "${CYAN}── PM2 ───────────────────────────────${NC}"
  pm2 status 2>/dev/null || echo "PM2 not found"
  echo ""
  echo -e "${CYAN}── Services ──────────────────────────${NC}"
  for svc in mongod nginx; do
    systemctl is-active --quiet "$svc" 2>/dev/null \
      && echo -e "  ${GREEN}[✓]${NC} $svc  RUNNING" \
      || echo -e "  ${RED}[✗]${NC} $svc  STOPPED"
  done
  echo ""
  echo -e "${CYAN}── Network ───────────────────────────${NC}"
  echo -e "  IP : ${CYAN}$(hostname -I | awk '{print $1}')${NC}"
  ss -tlnp 2>/dev/null | grep -E ':80|:443|:3000|:27017' | awk '{print "  Port: "$4}' || true
}

# ================================================================
#  LOGS / RESTART / STOP
# ================================================================
cmd_logs()    { pm2 logs "$APP_NAME" --lines 100; }
cmd_restart() { check_root restart; pm2 restart "$APP_NAME"; pm2 status; }
cmd_stop()    { check_root stop;    pm2 stop    "$APP_NAME"; pm2 status; }

# ================================================================
#  MAIN
# ================================================================
echo ""
echo -e "${BLUE}  InvestySignals Deploy Script${NC}"
echo ""
case "${1:-help}" in
  install) cmd_install ;;
  update)  cmd_update  ;;
  status)  cmd_status  ;;
  logs)    cmd_logs    ;;
  restart) cmd_restart ;;
  stop)    cmd_stop    ;;
  *)
    echo "  Usage: sudo bash deploy.sh [command]"
    echo ""
    echo "  install  — Fresh VPS: Node, MongoDB, Nginx, PM2, App"
    echo "  update   — GitHub pull + npm update + restart"
    echo "  status   — All services status"
    echo "  logs     — Live logs"
    echo "  restart  — Restart app"
    echo "  stop     — Stop app"
    echo ""
    ;;
esac
