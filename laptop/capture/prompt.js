const ip = document.getElementById('ip');
document.getElementById('ok').onclick = () => window.kv.submit(ip.value.trim());
document.getElementById('cancel').onclick = () => window.kv.submit(null);
ip.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') window.kv.submit(ip.value.trim());
  if (e.key === 'Escape') window.kv.submit(null);
});
