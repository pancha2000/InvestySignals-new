import os
import re

nav_html = """    <nav class="auth-nav">
        <div class="auth-nav-left">
            <button class="auth-hamburger" id="authHamburger">☰</button>
            <a href="index.html" class="logo">
                <span class="logo-icon">◈</span> INVESTY<span class="logo-accent">SIGNALS</span>
            </a>
        </div>
        <div class="auth-nav-menu" id="authNavMenu">
            <a href="dashboard.html" class="auth-nav-link">Dashboard</a>
            <a href="analysis.html" class="auth-nav-link">Analysis</a>
            <a href="live-signals.html" class="auth-nav-link">Paper Trading</a>
            <a href="signals.html" class="auth-nav-link">Signals</a>
            <a href="profile.html" class="auth-nav-link">Profile</a>
        </div>
        <div class="auth-nav-right">
            <div class="user-chip" id="userChip" style="display: flex;">
                <div class="user-avatar" id="userAvatar">U</div>
                <div class="user-name" id="userName" style="display: block;">User</div>
            </div>
            <button id="logoutBtn" class="btn btn-ghost" style="padding: 6px 12px; font-size: 0.875rem;">Logout</button>
        </div>
    </nav>"""

js_code = """
        const authHamburger = document.getElementById('authHamburger');
        const authNavMenu = document.getElementById('authNavMenu');
        if (authHamburger) {
            authHamburger.addEventListener('click', () => {
                authNavMenu.classList.toggle('open');
            });
        }
    </script>
</body>"""

files_to_update = ['analysis.html', 'profile.html', 'signals.html', 'live-signals.html']

for f in files_to_update:
    if os.path.exists(f):
        with open(f, 'r', encoding='utf-8') as file:
            content = file.read()
        
        # Replace the entire <nav class="auth-nav">...</nav>
        # using regex dotall
        new_content = re.sub(r'<nav class="auth-nav">.*?</nav>', nav_html, content, flags=re.DOTALL)
        
        # Add JS before </body>
        # if it's not already added
        if 'authHamburger' not in new_content:
            new_content = new_content.replace('</script>\n</body>', js_code)
            
        with open(f, 'w', encoding='utf-8') as file:
            file.write(new_content)
        print(f"Updated {f}")
