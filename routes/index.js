var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'Material prestado en la Red de Bibliotecas del Banco de la República' });
});

module.exports = router;
