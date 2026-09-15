'use strict';

// Protección CSRF para los POST de la API. Además de la cookie SameSite=Strict, se exige que
// la solicitud venga del mismo origen (Sec-Fetch-Site / Origin) y con cuerpo JSON.
function sameOriginOnly(req, res, next) {
  const site = req.get('Sec-Fetch-Site');
  const origin = req.get('Origin');

  let crossOrigin = Boolean(site) && site !== 'same-origin' && site !== 'none';
  if (!crossOrigin && origin) {
    try {
      crossOrigin = new URL(origin).host !== req.host;
    } catch {
      crossOrigin = true;
    }
  }

  if (crossOrigin) return res.status(403).json({ error: 'Solicitud no permitida.' });
  if (!req.is('application/json')) return res.status(415).json({ error: 'Tipo de contenido no soportado.' });
  next();
}

module.exports = { sameOriginOnly };
