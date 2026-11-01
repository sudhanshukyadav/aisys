const nav = document.getElementById('nav');
window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 20));

const navToggle = document.getElementById('navToggle');
const navInner = document.querySelector('.nav__inner');
navToggle.addEventListener('click', () => navInner.classList.toggle('open'));

document.querySelectorAll('.nav__links a').forEach(a => {
  a.addEventListener('click', () => navInner.classList.remove('open'));
});

const form = document.getElementById('waitlistForm');
const msg = document.getElementById('formMsg');
const emailInput = document.getElementById('emailInput');

form.addEventListener('submit', async e => {
  e.preventDefault();
  const email = emailInput.value.trim();
  msg.className = 'cta__msg';
  msg.textContent = '';
  try {
    const res = await fetch('/api/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (res.ok) {
      msg.className = 'cta__msg ok';
      msg.textContent = data.message || "You're on the list!";
      form.reset();
    } else {
      msg.className = 'cta__msg err';
      msg.textContent = data.error || 'Something went wrong.';
    }
  } catch {
    msg.className = 'cta__msg err';
    msg.textContent = 'Network error.';
  }
});