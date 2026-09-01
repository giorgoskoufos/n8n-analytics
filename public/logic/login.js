// ==========================================
// Login Logic - n8n Analytics
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
    // 1. If the user ALREADY has a token, redirect them to the dashboard!
    const token = localStorage.getItem('n8n_auth_token');
    if (token) {
        window.location.href = '../index.html';
        return;
    }

    // Check for expired session reason
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('reason') === 'expired') {
        const errorDiv = document.getElementById('loginError');
        if (errorDiv) {
            errorDiv.innerText = 'Session expired. Please log in again.';
            errorDiv.classList.remove('hidden');
        }
    }

    // 2. Login Form Handling
    const loginForm = document.getElementById('loginForm');
    
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault(); // Prevent page reload
            
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const errorDiv = document.getElementById('loginError');
            const btn = document.getElementById('loginBtn');

            // UI State: Loading
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
            btn.disabled = true;
            errorDiv.classList.add('hidden');

            try {
                // Post to backend (root /api/ from /pages/ context)
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });

                const data = await response.json();

                if (response.ok) {
                    // Store token in browser
                    localStorage.setItem('n8n_auth_token', data.token);
                    
                    // Redirect to the main Dashboard!
                    window.location.href = '../index.html';
                } else {
                    // Display Error
                    errorDiv.innerText = data.error || 'Login failed';
                    errorDiv.classList.remove('hidden');
                }
            } catch (err) {
                errorDiv.innerText = 'Server communication error.';
                errorDiv.classList.remove('hidden');
                console.error(err);
            } finally {
                // Restore button state
                btn.innerHTML = '<span>Login</span> <i class="fa-solid fa-arrow-right text-sm"></i>';
                btn.disabled = false;
            }
        });
    }

    // 3. Interactive Dotted Canvas & Logo Glow Logic
    const authCard = document.getElementById('authCard');
    const logoBadge = document.getElementById('logoBadge');
    const logoGlow = document.getElementById('logoGlow');

    window.addEventListener('mousemove', (e) => {
        // 1. Update global cursor position for orange dotted hover spotlight
        document.documentElement.style.setProperty('--mouse-screen-x', `${e.clientX}px`);
        document.documentElement.style.setProperty('--mouse-screen-y', `${e.clientY}px`);

        // 2. Soft Logo Glow Proximity (50% subtle intensity)
        if (logoBadge && logoGlow) {
            const logoRect = logoBadge.getBoundingClientRect();
            const logoCenterX = logoRect.left + logoRect.width / 2;
            const logoCenterY = logoRect.top + logoRect.height / 2;
            const distToLogo = Math.hypot(e.clientX - logoCenterX, e.clientY - logoCenterY);

            const logoProximity = Math.max(0, 1 - distToLogo / 240);
            logoGlow.style.opacity = (0.25 + logoProximity * 0.25).toFixed(2);
            logoGlow.style.transform = `scale(${1 + logoProximity * 0.08})`;
        }
    }, { passive: true });
});