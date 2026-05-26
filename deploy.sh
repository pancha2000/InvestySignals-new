#!/bin/bash
# ================================================================
#  InvestySignals — Deploy Script v2
#
#  COMMANDS:
#    sudo bash deploy.sh install          — Fresh VPS install
#    sudo bash deploy.sh install-domain   — Add domain + SSL
#    sudo bash deploy.sh update           — Pull latest + restart
#    sudo bash deploy.sh status           — Check all services
#    sudo bash deploy.sh logs             — Live logs
#    sudo bash deploy.sh restart          — Restart app
#    sudo bash deploy.sh stop             — Stop app
# ================================================================

set -e

REPO_URL="https://github.com/pancha2000/InvestySignals-new.git"
APP_DIR="/var/www/investysignals"
APP_NAME="investysignals"
NODE_VERSION="20"
VPS_IP=$(hostname -I | awk '{print $1}')

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log()     { echo -e "${GREEN}[✓]${NC} $1"; }
warn()    { echo -e "${YELLOW}[!]${NC} $1"; }
error()   { echo -e "${RED}[✗] $1${NC}"; exit 1; }
info()    { echo -e "${CYAN}[→]${NC} $1"; }
section() {
  echo ""
  echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
  printf  "${BLUE}║  %-40s║${NC}\n" "$1"
  echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
}

check_root() { [ "$EUID" -eq 0 ] || error "Root required: sudo bash deploy.sh $1"; }

# ================================================================
#  INSTALL — Fresh VPS
# ================================================================
cmd_install() {
  check_root install
  section "InvestySignals — Fresh Install"

  # ── 1. System Packages ──────────────────────────────────────
  section "Step 1/8 — System Packages"
  apt-get update -qq
  apt-get install -y curl gnupg git unzip software-properties-common \
                     ca-certificates lsb-release ufw nginx openssl certbot \
                     python3-certbot-nginx
  log "System packages ready"

  # ── 2. Node.js ──────────────────────────────────────────────
  section "Step 2/8 — Node.js ${NODE_VERSION}"
  if command -v node &>/dev/null && \
     [ "$(node -v | sed 's/v//' | cut -d. -f1)" -ge "${NODE_VERSION}" ]; then
    log "Node.js $(node -v) already installed"
  else
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
    log "Node.js $(node -v) installed"
  fi

  # ── 3. MongoDB ──────────────────────────────────────────────
  section "Step 3/8 — MongoDB"
  if command -v mongod &>/dev/null; then
    log "MongoDB already installed"
  else
    UBUNTU_VER=$(lsb_release -rs)
    UBUNTU_CS=$(lsb_release -cs)
    info "Ubuntu $UBUNTU_VER ($UBUNTU_CS) detected"
    rm -f /etc/apt/sources.list.d/mongodb-org-*.list

    if [[ "$UBUNTU_VER" == "24.04" ]]; then
      info "Installing MongoDB 8.0 for Ubuntu 24.04..."
      curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
        | gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
      echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] \
https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
        > /etc/apt/sources.list.d/mongodb-org-8.0.list
    else
      info "Installing MongoDB 7.0 for Ubuntu $UBUNTU_VER..."
      curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc \
        | gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
      echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] \
https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" \
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
  section "Step 4/8 — PM2"
  if command -v pm2 &>/dev/null; then
    log "PM2 already installed"
  else
    npm install -g pm2
    log "PM2 installed"
  fi

  # ── 5. Clone + Config ───────────────────────────────────────
  section "Step 5/8 — Clone Repository"
  if [ -d "$APP_DIR/.git" ]; then
    warn "$APP_DIR exists — pulling latest"
    cd "$APP_DIR" && git pull
  else
    git clone "$REPO_URL" "$APP_DIR"
    log "Repository cloned to $APP_DIR"
  fi

  # Move misplaced model files to models/ if needed
  for f in PaperTrade.js BalanceRequest.js; do
    if [ -f "$APP_DIR/$f" ] && [ ! -f "$APP_DIR/models/$f" ]; then
      mv "$APP_DIR/$f" "$APP_DIR/models/$f"
      log "Moved $f → models/$f"
    fi
  done

  # serviceAccount.json
  if [ ! -f "$APP_DIR/serviceAccount.json" ]; then
    echo ""
    warn "══════════════════════════════════════════"
    warn "  serviceAccount.json NOT FOUND!"
    warn "  ඔයාගෙ computer ඒකෙ new terminal ඒකෙ:"
    warn ""
    warn "  scp serviceAccount.json root@${VPS_IP}:${APP_DIR}/"
    warn ""
    warn "══════════════════════════════════════════"
    read -p "  Upload කළාද? (y/n): " SA_DONE
    [[ "$SA_DONE" =~ ^[Yy]$ ]] || error "serviceAccount.json required"
    [ -f "$APP_DIR/serviceAccount.json" ] || error "File not found at $APP_DIR/serviceAccount.json"
  fi
  log "serviceAccount.json found"

  # .env setup
  if [ ! -f "$APP_DIR/.env" ]; then
    if [ -f "$APP_DIR/.env.example" ]; then
      cp "$APP_DIR/.env.example" "$APP_DIR/.env"
      warn ".env created from .env.example — edit it now!"
    else
      # Create minimal .env
      cat > "$APP_DIR/.env" << ENVEOF
MONGO_URI=mongodb://127.0.0.1:27017/investysignals
GROQ_API_KEY=your_groq_api_key_here
PORT=3000
ALLOWED_ORIGIN=http://${VPS_IP}
ENVEOF
      warn ".env created with defaults — edit GROQ_API_KEY!"
    fi
    nano "$APP_DIR/.env"
  else
    log ".env already exists"
  fi

  info "Installing npm packages..."
  cd "$APP_DIR" && npm install --production
  log "npm packages installed"

  # ── 6. Nginx — HTTP only (SSL later) ────────────────────────
  section "Step 6/8 — Nginx (HTTP)"
  _write_nginx_http "$VPS_IP"
  ln -sf /etc/nginx/sites-available/investysignals /etc/nginx/sites-enabled/investysignals
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
  log "Nginx configured (HTTP)"

  # ── 7. Firewall ─────────────────────────────────────────────
  section "Step 7/8 — Firewall"
  ufw allow OpenSSH      2>/dev/null || true
  ufw allow 'Nginx Full' 2>/dev/null || true
  ufw --force enable     2>/dev/null || true
  log "Firewall configured"

  # ── 8. Start App ────────────────────────────────────────────
  section "Step 8/8 — Start Application"
  cd "$APP_DIR"
  pm2 delete "$APP_NAME" 2>/dev/null || true
  pm2 start server.js --name "$APP_NAME" --restart-delay=3000 --max-restarts=10 --time
  pm2 save
  PM2_CMD=$(pm2 startup systemd -u root --hp /root 2>/dev/null | grep "sudo" | tail -1)
  [ -n "$PM2_CMD" ] && eval "$PM2_CMD" 2>/dev/null || true
  pm2 save

  # ── Done ────────────────────────────────────────────────────
  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║          ✅  Installation Complete!              ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  🌐 Website  : ${CYAN}http://${VPS_IP}${NC}"
  echo ""
  echo -e "  📌 Next Steps:"
  echo -e "     1. Domain DNS ➜ A record → ${VPS_IP}"
  echo -e "     2. DNS propagate වෙලා: ${YELLOW}sudo bash deploy.sh install-domain${NC}"
  echo -e "     3. Edit .env if needed: ${YELLOW}nano ${APP_DIR}/.env${NC}"
  echo ""
  pm2 status
}

# ================================================================
#  INSTALL-DOMAIN — Add domain + SSL
# ================================================================
cmd_install_domain() {
  check_root install-domain
  section "InvestySignals — Domain + SSL Setup"

  [ -d "$APP_DIR" ] || error "App not installed. Run: sudo bash deploy.sh install"

  # Get domain
  echo ""
  read -p "  ඔයාගෙ domain ඒකෙ enter කරන්නෙ (eg: investysignals.com): " DOMAIN
  [ -z "$DOMAIN" ] && error "Domain required"
  DOMAIN=$(echo "$DOMAIN" | sed 's|https\?://||' | sed 's|/.*||' | tr -d ' ')
  info "Domain: $DOMAIN"

  # DNS check
  info "DNS check..."
  SERVER_IP=$(hostname -I | awk '{print $1}')
  DOMAIN_IP=$(dig +short "$DOMAIN" 2>/dev/null | head -1 || nslookup "$DOMAIN" 2>/dev/null | grep "Address:" | tail -1 | awk '{print $2}' || echo "")

  if [ "$DOMAIN_IP" != "$SERVER_IP" ]; then
    warn "DNS not propagated yet!"
    warn "  Domain $DOMAIN → $DOMAIN_IP"
    warn "  Server IP      → $SERVER_IP"
    warn "  DNS propagate වෙලා ආයෙ run කරන්නෙ"
    read -p "  Continue anyway? (y/n): " CONT
    [[ "$CONT" =~ ^[Yy]$ ]] || exit 0
  else
    log "DNS OK: $DOMAIN → $SERVER_IP"
  fi

  # Update Nginx for domain
  info "Updating Nginx for $DOMAIN..."
  _write_nginx_http "$DOMAIN www.$DOMAIN"
  nginx -t && systemctl reload nginx
  log "Nginx updated"

  # Get SSL certificate
  info "Getting SSL certificate from Let's Encrypt..."
  certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos \
    --register-unsafely-without-email || \
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    --register-unsafely-without-email
  log "SSL certificate installed"

  # Update .env ALLOWED_ORIGIN
  if [ -f "$APP_DIR/.env" ]; then
    sed -i "s|ALLOWED_ORIGIN=.*|ALLOWED_ORIGIN=https://$DOMAIN|" "$APP_DIR/.env"
    log "ALLOWED_ORIGIN updated to https://$DOMAIN"
  fi

  # Restart app
  pm2 restart "$APP_NAME" --update-env
  pm2 save

  # Auto-renew test
  certbot renew --dry-run &>/dev/null && log "SSL auto-renewal OK" || warn "SSL renewal test failed — check manually"

  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║          ✅  Domain + SSL Complete!              ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  🌐 Website : ${CYAN}https://$DOMAIN${NC}"
  echo -e "  🔒 HTTPS   : Let's Encrypt SSL (auto-renews)"
  echo ""
}

# ── Nginx config helper ───────────────────────────────────────
_write_nginx_http() {
  local SERVER_NAME="$1"
  cat > /etc/nginx/sites-available/investysignals << NGINXEOF
server {
    listen 80;
    server_name ${SERVER_NAME};

    client_max_body_size 10M;
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 86400;
    }

    location ~* \.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2)\$ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
}
NGINXEOF
}

# ================================================================
#  UPDATE — GitHub pull
# ================================================================
cmd_update() {
  check_root update
  section "InvestySignals — Update"
  [ -d "$APP_DIR" ] || error "$APP_DIR not found. Run install first."

  info "Backing up config..."
  cp "$APP_DIR/.env"                /tmp/.investy_env_bak 2>/dev/null || true
  cp "$APP_DIR/serviceAccount.json" /tmp/.investy_sa_bak  2>/dev/null || true

  info "Pulling from GitHub..."
  cd "$APP_DIR"
  git fetch origin
  git reset --hard origin/main
  log "Code updated"

  # Restore config
  cp /tmp/.investy_env_bak  "$APP_DIR/.env"                2>/dev/null || true
  cp /tmp/.investy_sa_bak   "$APP_DIR/serviceAccount.json" 2>/dev/null || true
  log "Config files preserved"

  # Fix model paths if needed
  for f in PaperTrade.js BalanceRequest.js; do
    if [ -f "$APP_DIR/$f" ] && [ ! -f "$APP_DIR/models/$f" ]; then
      mv "$APP_DIR/$f" "$APP_DIR/models/$f"
      log "Moved $f → models/$f"
    fi
  done

  info "Updating npm packages..."
  cd "$APP_DIR" && npm install --production
  log "npm updated"

  info "Restarting..."
  pm2 restart "$APP_NAME" --update-env || \
    pm2 start server.js --name "$APP_NAME" --restart-delay=3000
  pm2 save

  echo ""
  echo -e "${GREEN}╔════════════════════════════════╗${NC}"
  echo -e "${GREEN}║   ✅  Update Complete!         ║${NC}"
  echo -e "${GREEN}╚════════════════════════════════╝${NC}"
  echo ""
  pm2 status
}

# ================================================================
#  STATUS / LOGS / RESTART / STOP
# ================================================================
cmd_status() {
  section "InvestySignals — Status"
  echo -e "${CYAN}── PM2 ──────────────────────────────────${NC}"
  pm2 status 2>/dev/null || echo "  PM2 not running"
  echo ""
  echo -e "${CYAN}── Services ─────────────────────────────${NC}"
  for svc in mongod nginx; do
    systemctl is-active --quiet "$svc" 2>/dev/null \
      && echo -e "  ${GREEN}[✓]${NC} $svc  RUNNING" \
      || echo -e "  ${RED}[✗]${NC} $svc  STOPPED"
  done
  echo ""
  echo -e "${CYAN}── SSL ──────────────────────────────────${NC}"
  if [ -d /etc/letsencrypt/live ]; then
    for cert_dir in /etc/letsencrypt/live/*/; do
      domain=$(basename "$cert_dir")
      expiry=$(openssl x509 -enddate -noout -in "$cert_dir/cert.pem" 2>/dev/null | cut -d= -f2 || echo "unknown")
      echo -e "  ${GREEN}[✓]${NC} $domain  →  expires: $expiry"
    done
  else
    echo -e "  ${YELLOW}[!]${NC} No SSL certs found"
  fi
  echo ""
  echo -e "${CYAN}── URL ──────────────────────────────────${NC}"
  if [ -d /etc/letsencrypt/live ]; then
    for cert_dir in /etc/letsencrypt/live/*/; do
      domain=$(basename "$cert_dir")
      echo -e "  ${CYAN}https://$domain${NC}"
    done
  else
    echo -e "  ${CYAN}http://$(hostname -I | awk '{print $1}')${NC}"
  fi
  echo ""
}

cmd_logs()    { pm2 logs "$APP_NAME" --lines 100; }
cmd_restart() { check_root restart; pm2 restart "$APP_NAME" --update-env; pm2 status; }
cmd_stop()    { check_root stop; pm2 stop "$APP_NAME"; pm2 status; }

# ================================================================
#  MAIN
# ================================================================
echo ""
echo -e "${BLUE}  InvestySignals Deploy Script v2${NC}"
echo ""
case "${1:-help}" in
  install)        cmd_install ;;
  install-domain) cmd_install_domain ;;
  update)         cmd_update ;;
  status)         cmd_status ;;
  logs)           cmd_logs ;;
  restart)        cmd_restart ;;
  stop)           cmd_stop ;;
  *)
    echo "  Usage: sudo bash deploy.sh [command]"
    echo ""
    echo "  install         — Fresh VPS: Node, MongoDB, Nginx, PM2, App"
    echo "  install-domain  — Domain + Free SSL (Let's Encrypt)"
    echo "  update          — GitHub pull + npm update + restart"
    echo "  status          — All services + SSL expiry check"
    echo "  logs            — Live logs"
    echo "  restart         — Restart app"
    echo "  stop            — Stop app"
    echo ""
    ;;
esac
