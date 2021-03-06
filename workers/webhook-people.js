const express = require('express');
const bodyParser = require('body-parser');
const request = require('request-promise');
const base64 = require('js-base64').Base64;

function encodeAPIKey(APIKey) {
  return 'Basic ' + base64.encode(`${APIKey}:`);
}

const webHookKey = process.env.WEBHOOK_NB_KEY;
const webSparkpostHookKey = process.env.WEBHOOK_SPARKPOST_KEY;
const webhookSendgridKey = process.env.WEBHOOK_SENDGRID_KEY;
const APIKey = process.env.API_KEY;
const MailTrainKey = process.env.MAILTRAIN_KEY;
const NBAPIKey = process.env.NB_API_KEY_2;

const api = require('./lib/api');
var updatePerson = require('./lib/people').updatePerson;

var app = express();

app.use(bodyParser.json());
app.post('/people', (req, res) => {
  if (req.body.token !== webHookKey) {
    return res.sendStatus(401);
  }

  var nbPerson = req.body.payload.person;
  if (!nbPerson) return res.sendStatus(400);

  updatePerson(nbPerson);

  return res.sendStatus(202);
});

app.post('/ses_bounce', bodyParser.text(), (req, res) => {
  req.body = JSON.parse(req.body);
  if (req.body.Type === 'SubscriptionConfirmation') {
    request(req.body.SubscribeURL);
    return res.sendStatus(200);
  }

  if (req.body.Type !== 'Notification') return res.sendStatus(200);

  var message = JSON.parse(req.body.Message);
  if (message.notificationType !== 'Bounce') return res.sendStatus(200);
  if (message.bounce.bounceType !== 'Permanent') return res.sendStatus(200);

  console.log('Amazon SES bounce : ' + message.mail.destination[0]);
  removeBounce(message.mail.destination[0]);

  return res.sendStatus(200);
});

app.post('/sendgrid_bounce', (req, res) => {
  if (req.header('Authorization') !== `Basic ${base64.encode(`jlm2017:${webhookSendgridKey}`)}`) {
    console.log(req.header('Authorization'));
    return res.sendStatus(401);
  }

  for (var i = 0; i < req.body.length; i++) {
    var webhook = req.body[i];

    if (webhook.event !== 'bounce') continue;
    if (webhook.type !== 'bounce') continue;

    console.log('Sendgrid bounce : ' + webhook.email);
    removeBounce(webhook.email);
  }

  res.sendStatus(200);
});

app.post('/signup_bounce', (req, res) => {
  if (req.header('Authorization') !== `Basic ${base64.encode(`jlm2017:${webSparkpostHookKey}`)}`) {
    console.log(req.header('Authorization'));
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  for (var i = 0; i < req.body.length; i++) {
    var webhook = req.body[i].msys;
    if (webhook.message_event && ['10', '30'].indexOf(webhook.message_event.bounce_class) !== -1) {
      console.log('Sparkpost bounce : ' + webhook.message_event.raw_rcpt_to);
      removeBounce(webhook.message_event.raw_rcpt_to);
    }
  }
});

function removeBounce(recipient) {
  console.log('hard bounce', recipient);
  api.get_resource({resource: 'people', where: `email=="${recipient}"`, APIKey})
    .then((people) => {
      if (people._items.length === 0) {
        console.log(recipient, ': not in database');
        return false;
      }

      var oneHourAgo = new Date();
      oneHourAgo.setHours(oneHourAgo.getHours() -1);
      if (new Date(people._items[0]._created) < oneHourAgo) {
        console.log(recipient, ': created more than one hour ago');

        return api.patch_resource('people', people._items[0], {
          bounced: true,
          bounced_date: new Date().toUTCString()
        }, APIKey).then(() => {
          console.log(recipient, ': marked as bounced');
        });
      }

      var id = people._items[0]._id;
      var NBid = people._items[0].id;
      var etag = people._items[0]._etag;
      return request({
        url: `http://localhost:5000/people/${id}`,
        method: 'DELETE',
        json: true,
        headers: {
          Authorization: encodeAPIKey(APIKey),
          'If-Match': etag
        }
      }).then(() => {
        return request({
          url: `https://plp.nationbuilder.com/api/v1/people/${NBid}?access_token=${NBAPIKey}`,
          json: true,
          method: 'DELETE'
        });
      }).then(() => {
        return request.post({
          url: `https://newsletter.jlm2017.fr/api/unsubscribe/SyWda9pi?access_token=${MailTrainKey}`,
          body: {
            EMAIL: recipient,
          },
          json: true
        });
      }).then(() => {
        console.log(recipient, ': deleted');
      });
    }).catch(err => {
      console.error(err.stack);
    });
}

app.listen(4000, '127.0.0.1');
