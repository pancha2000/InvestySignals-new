#!/bin/bash
# ============================================================
#  InvestySignals — VPS Install & Update Script
#  
#  INSTALL:  bash deploy.sh install
#  UPDATE:   bash deploy.sh update
#  STATUS:   bash deploy.sh status
#  LOGS:     bash deploy.sh logs
#  RESTART:  bash deploy.sh restart
# ============================================================

set -e

APP_DIR="/var/www/investysignals"
APP_NAME="investysignals"
NGINX_CONF="/etc/nginx/sites-available/investysignals"
NODE_MIN_VERSION=18

# ── Colors ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log()    { echo -e "${GREEN}[✓]${NC} $1"; }
warn()   { echo -e "${YELLOW}[!]${NC} $1"; }
error()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
section(){ echo -e "\n${BLUE}══════════════════════════════════${NC}"; echo -e "${BLUE}  $1${NC}"; echo -e "${BLUE}══════════════════════════════════${NC}"; }

# ── Check root ────────────────────────────────────────────────
check_root() {
  if [ "$EUID" -ne 0 ]; then
    error "Please run as root: sudo bash deploy.sh $1"
  fi
}

# ── Install Node.js ───────────────────────────────────────────
install_node() {
  if command -v node &>/dev/null; then
    NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VER" -ge "$NODE_MIN_VERSION" ]; then
      log "Node.js $(node -v) already installed"
      return
    fi
  fi
  warn "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  log "Node.js $(node -v) installed"
}

# ── Install MongoDB ───────────────────────────────────────────
install_mongodb() {
  if command -v mongod &>/dev/null; then
    log "MongoDB already installed"
    systemctl enable mongod
    systemctl start mongod
    return
  fi
  warn "Installing MongoDB 7..."
  curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
    gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] \
https://repo.mongodb.org/apt/ubuntu $(lsb_release -cs)/mongodb-org/7.0 multiverse" \
    | tee /etc/apt/sources.list.d/mongodb-org-7.0.list
  apt-get update -qq
  apt-get install -y mongodb-org
  systemctl enable mongod
  systemctl start mongod
  log "MongoDB installed and started"
}

# ── Install PM2 ───────────────────────────────────────────────
install_pm2() {
  if command -v pm2 &>/dev/null; then
    log "PM2 already installed"
    return
  fi
  npm install -g pm2
  log "PM2 installed"
}

# ── INSTALL ───────────────────────────────────────────────────
cmd_install() {
  check_root install
  section "InvestySignals — Full Install"

  # System packages
  log "Updating system packages..."
  apt-get update -qq
  apt-get install -y curl gnupg git unzip nginx certbot python3-certbot-nginx

  # Node.js
  install_node

  # MongoDB
  install_mongodb

  # PM2
  install_pm2

  # App directory
  section "Setting up application..."
  mkdir -p "$APP_DIR"

  # Copy files (run from directory containing deploy.sh)
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  cp -r "$SCRIPT_DIR"/. "$APP_DIR/"
  log "Files copied to $APP_DIR"

  # serviceAccount.json check
  if [ ! -f "$APP_DIR/serviceAccount.json" ]; then
    warn "serviceAccount.json NOT FOUND in $APP_DIR"
    warn "Upload your Firebase service account file to: $APP_DIR/serviceAccount.json"
  else
    log "serviceAccount.json found"
  fi

  # .env setup
  if [ ! -f "$APP_DIR/.env" ]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    warn ".env file created from template"
    warn "Edit $APP_DIR/.env if needed (e.g. for MongoDB Atlas)"
  else
    log ".env already exists"
  fi

  # Install npm packages
  section "Installing Node.js dependencies..."
  cd "$APP_DIR"
  npm install --production
  log "npm packages installed"

  # Nginx
  section "Configuring Nginx..."
  if [ ! -f "$NGINX_CONF" ]; then
    cp "$APP_DIR/nginx.conf" "$NGINX_CONF"
    ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/investysignals
    # Remove default site
    rm -f /etc/nginx/sites-enabled/default
    log "Nginx config installed"
    warn "Edit $NGINX_CONF and replace YOUR_DOMAIN_OR_IP with your actual domain/IP"
  else
    log "Nginx config already exists (not overwritten)"
  fi

  nginx -t && systemctl reload nginx
  log "Nginx reloaded"

  # Start app with PM2
  section "Starting application..."
  cd "$APP_DIR"
  pm2 delete "$APP_NAME" 2>/dev/null || true
  pm2 start server.js --name "$APP_NAME" --restart-delay=3000 --max-restarts=10
  pm2 save
  pm2 startup | tail -1 | bash 2>/dev/null || true
  log "Application started with PM2"

  section "✅ Installation Complete!"
  echo ""
  echo "  Next steps:"
  echo "  1. Edit Nginx config:  nano $NGINX_CONF"
  echo "     → Replace YOUR_DOMAIN_OR_IP with your domain/IP"
  echo "     → Run: nginx -t && systemctl reload nginx"
  echo ""
  echo "  2. SSL setup (optional, needs domain):"
  echo "     certbot --nginx -d yourdomain.com"
  echo ""
  echo "  3. Check status:  bash $SCRIPT_DIR/deploy.sh status"
  echo "  4. View logs:     bash $SCRIPT_DIR/deploy.sh logs"
  echo ""
  pm2 status
}

# ── UPDATE ────────────────────────────────────────────────────
cmd_update() {
  check_root update
  section "InvestySignals — Update"

  if [ ! -d "$APP_DIR" ]; then
    error "$APP_DIR not found. Run install first: sudo bash deploy.sh install"
  fi

  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

  # Backup .env and serviceAccount.json
  log "Backing up config files..."
  cp "$APP_DIR/.env" /tmp/investysignals_env_backup 2>/dev/null || true
  cp "$APP_DIR/serviceAccount.json" /tmp/investysignals_sa_backup 2>/dev/null || true

  # Copy new files
  log "Copying updated files..."
  rsync -av --exclude='.env' \
            --exclude='serviceAccount.json' \
            --exclude='node_modules' \
            --exclude='.env.example' \
            "$SCRIPT_DIR"/ "$APP_DIR/"

  # Restore backups
  cp /tmp/investysignals_env_backup "$APP_DIR/.env" 2>/dev/null || true
  cp /tmp/investysignals_sa_backup "$APP_DIR/serviceAccount.json" 2>/dev/null || true
  log "Config files preserved"

  # Update npm packages
  section "Updating dependencies..."
  cd "$APP_DIR"
  npm install --production
  log "Dependencies updated"

  # Restart
  section "Restarting application..."
  pm2 restart "$APP_NAME" || pm2 start server.js --name "$APP_NAME"
  pm2 save

  section "✅ Update Complete!"
  pm2 status
}

# ── STATUS ────────────────────────────────────────────────────
cmd_status() {
  section "InvestySignals — Status"
  echo "--- PM2 ---"
  pm2 status 2>/dev/null || echo "PM2 not running"
  echo ""
  echo "--- MongoDB ---"
  systemctl is-active mongod && echo "MongoDB: RUNNING" || echo "MongoDB: STOPPED"
  echo ""
  echo "--- Nginx ---"
  systemctl is-active nginx && echo "Nginx: RUNNING" || echo "Nginx: STOPPED"
  echo ""
  echo "--- Port 3000 ---"
  ss -tlnp | grep :3000 && echo "Port 3000: LISTENING" || echo "Port 3000: NOT listening"
}

# ── LOGS ──────────────────────────────────────────────────────
cmd_logs() {
  pm2 logs "$APP_NAME" --lines 50
}

# ── RESTART ───────────────────────────────────────────────────
cmd_restart() {
  check_root restart
  pm2 restart "$APP_NAME"
  log "Application restarted"
  pm2 status
}

# ── STOP ──────────────────────────────────────────────────────
cmd_stop() {
  check_root stop
  pm2 stop "$APP_NAME"
  log "Application stopped"
}

# ── Main ──────────────────────────────────────────────────────
case "${1:-help}" in
  install) cmd_install ;;
  update)  cmd_update  ;;
  status)  cmd_status  ;;
  logs)    cmd_logs    ;;
  restart) cmd_restart ;;
  stop)    cmd_stop    ;;
  *)
    echo ""
    echo "  InvestySignals Deploy Script"
    echo ""
    echo "  Usage: sudo bash deploy.sh [command]"
    echo ""
    echo "  Commands:"
    echo "    install   — Full install (Node, MongoDB, PM2, Nginx, App)"
    echo "    update    — Update app files and restart"
    echo "    status    — Show service status"
    echo "    logs      — Show application logs"
    echo "    restart   — Restart the application"
    echo "    stop      — Stop the application"
    echo ""
    ;;
esac
