var express = require('express');
var router = express.Router();
var async = require('async');
var nconf = require('nconf');

var alma = require('../alma.js');

function getLibraries(req, callback) {
    if (req.app.libraries) {
        callback(null, req.app.libraries);
    }
    else {
        alma.get('/conf/libraries',
            function (err, data) {
                if (err) return callback(err);
                req.app.libraries = data;
                callback(null, data);
            });
    }
}

function getUserData(userId, callback) {
    var apikey = nconf.get('API_KEY');
    var apiUrl = 'https://api-na.hosted.exlibrisgroup.com/almaws/v1/users/' + userId + '?user_id_type=all_unique&view=full&expand=none&apikey=' + apikey;

    alma.get(apiUrl, function (err, userData) {
        if (err) return callback(err);

        callback(null, userData);
    });
}

router.get('/', function (req, res, next) {
    getLibraries(req,
        function (err, data) {
            if (err) return next(err);
            res.render('scan-in/index',
                { title: 'Escanear el ítem', libraries: data });
        }
    );
});

router.post('/', function (req, res, next) {
    var item, libraries, userData;
    async.waterfall([
        function (callback) {
            getLibraries(req, callback);
        },
        function (data, callback) {
            libraries = data;
            alma.get('/items?item_barcode=' + req.body.barcode, callback)
        },
        function (itemData, callback) {
            item = itemData;
            if (req.body.scan) {
                res.cookie('prefs',
                    {
                        library: req.body.library,
                        circ_desk: req.body.circ_desk
                    },
                    {
                        path: '/scan-in',
                        maxAge: 1000 * 60 * 60 * 24 * 7
                    });

                alma.post(item.link + '?op=scan&library=' + req.body.library +
                    '&circ_desk=' + req.body.circ_desk, null, callback);
            } else {
                callback(null, item);
            }
        },
        function (item, callback) {
            var apikey = nconf.get('API_KEY');
            var apiUrl = 'https://api-na.hosted.exlibrisgroup.com/almaws/v1/bibs/' + item.bib_data.mms_id + '/loans?limit=99999&offset=0&order_by=id&direction=asc&loan_status=Active&apikey=' + apikey;

            alma.get(apiUrl, function (err, loanData) {
                if (err) return callback(err);

                if (loanData && loanData.item_loan && loanData.item_loan.length > 0) {
                    item.userId = loanData.item_loan[0].user_id;
                    item.due_date = loanData.item_loan[0].due_date; // Agrega el campo due_date aquí
                }
                item.callNumber = item.holding_data.call_number;
                callback(null, item);
            });
        },
        function (item, callback) {
            if (item.userId) {
                getUserData(item.userId, function (err, data) {
                    if (err) return callback(err);
                    userData = data;
                    callback(null, item);
                });
            } else {
                callback(null, item);
            }
        }
    ],

	function (err, item) {
		if (err) {
			if (err.message.indexOf("401690") > 0 || err.message.indexOf("401689") > 0)
				return res.render('scan-in/index',
					{ title: 'Buscar por ítem', error: "Código invalido", libraries: libraries });
			else return next(err);
		}
		item.additionalInfo = {
			publisher: item.bib_data.publisher_const,
			publication_year: item.bib_data.date_of_publication
		};
		res.render('scan-in/index',
			{
				title: 'Buscar por ítem',
				item: item,
				libraries: libraries,
				userData: userData, // Asegúrate de incluir userData aquí
				error: (req.body.scan && !item.additional_info ? "No se puede escanear el elemento" : undefined),
				due_date: item.due_date // Asegúrate de incluir due_date aquí

			});
	});

});
module.exports = router;
