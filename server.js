const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1); // Nécessaire pour récupérer la vraie IP derrière un proxy/Render

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─────────────────────────────────────────────
//  CONNEXION MONGODB
// ─────────────────────────────────────────────
const mongoURI = "mongodb+srv://ahmedmhamdi_db_user:75Deu32ZXLW7H4vn@cluster0.nku2lm5.mongodb.net/presence_db?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(mongoURI)
  .then(() => console.log("✅ Connecté à MongoDB Atlas"))
  .catch(err => console.log("❌ Erreur MongoDB :", err));

// ─────────────────────────────────────────────
//  SCHEMAS
// ─────────────────────────────────────────────
const SeanceSchema = new mongoose.Schema({
  matiere:     String,
  date:        String,
  professorIP: String,   // IP du PC professeur (sous-réseau de référence)
  token:       String,   // Token secret embarqué dans le QR code
  tokenExpiry: Date,     // Expiration du token (15 min par défaut)
  etudiants:   Array,    // [{ nom, s1, s2 }]
  ipUtilisees: {         // IPs déjà utilisées par type de séance
    s1: [String],
    s2: [String]
  },
  tentativesBloquees: [{ // Log de sécurité des tentatives rejetées
    ip:      String,
    raison:  String,
    date:    { type: Date, default: Date.now }
  }]
});

const Seance = mongoose.model('Seance', SeanceSchema);
const EtudiantOfficiel = mongoose.model('Etudiant', new mongoose.Schema({ nom: String }), 'etudiants');

// ─────────────────────────────────────────────
//  RATE LIMITER — anti-brute-force
//  Max 10 tentatives / 15 min par IP
// ─────────────────────────────────────────────
const presenceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives. Réessayez dans 15 minutes." }
});

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────

/** Extraire l'IP cliente réelle (IPv4 propre) */
function getClientIP(req) {
  let ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
        || req.connection?.remoteAddress
        || req.socket?.remoteAddress
        || req.ip
        || '0.0.0.0';
  // Nettoyer le préfixe IPv6-mapped IPv4 (::ffff:192.168.x.x)
  return ip.replace(/^::ffff:/, '');
}

/** Vérifier que deux IPs sont sur le même sous-réseau /24 (même salle) */
function memeSousReseau(ip1, ip2) {
  try {
    const clean1 = ip1.replace(/^::ffff:/, '');
    const clean2 = ip2.replace(/^::ffff:/, '');
    const p1 = clean1.split('.');
    const p2 = clean2.split('.');
    if (p1.length !== 4 || p2.length !== 4) return false;
    // Comparer les 3 premiers octets (sous-réseau /24)
    return p1[0] === p2[0] && p1[1] === p2[1] && p1[2] === p2[2];
  } catch {
    return false;
  }
}

/** Générer un token sécurisé et sa date d'expiration */
function genererToken(minutesExpiry = 15) {
  return {
    token:  crypto.randomBytes(24).toString('hex'),
    expiry: new Date(Date.now() + minutesExpiry * 60 * 1000)
  };
}

// ─────────────────────────────────────────────
//  ROUTE 1 : DÉMARRER / RENOUVELER UNE SÉANCE
//  POST /demarrer-seance
//  Body : { matiere, date }
//  Réponse : { token, expiry, message }
// ─────────────────────────────────────────────
app.post('/demarrer-seance', async (req, res) => {
  try {
    const { matiere, date } = req.body;
    if (!matiere || !date) return res.status(400).json({ error: "Matière et date requises." });

    const professorIP = getClientIP(req);
    console.log(`📌 Professeur IP : ${professorIP}`);

    const { token, expiry } = genererToken(15);
    let seance = await Seance.findOne({ matiere, date });

    if (!seance) {
      // Nouvelle séance : charger la liste des étudiants officiels
      const inscrits = await EtudiantOfficiel.find();
      if (inscrits.length === 0)
        return res.status(400).json({ error: "Aucun étudiant dans la base." });

      const etudiants = inscrits.map(e => ({ nom: e.nom, s1: "Absent", s2: "Absent" }));
      seance = new Seance({
        matiere, date, professorIP, token, tokenExpiry: expiry,
        etudiants,
        ipUtilisees: { s1: [], s2: [] },
        tentativesBloquees: []
      });
    } else {
      // Séance existante : rafraîchir le token et l'IP professeur
      seance.professorIP = professorIP;
      seance.token       = token;
      seance.tokenExpiry = expiry;
    }

    await seance.save();
    console.log(`🔑 Nouveau token généré pour ${matiere} / ${date} — expire à ${expiry.toLocaleTimeString()}`);

    res.json({
      message: "Séance prête. QR Code valide 15 minutes.",
      token,
      expiry: expiry.toISOString()
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 2 : VALIDER LA PRÉSENCE D'UN ÉTUDIANT
//  POST /valider-presence
//  Body : { nom, date, matiere, typeSeance, token }
//
//  CONTRÔLES DE SÉCURITÉ (dans l'ordre) :
//   1. Séance existe ?
//   2. Token valide ?
//   3. Token non expiré ?
//   4. Même sous-réseau WiFi que le prof ?
//   5. IP déjà utilisée pour ce type de séance ?
//   6. Étudiant dans la liste officielle ?
//   7. Présence déjà enregistrée pour ce nom ?
// ─────────────────────────────────────────────
app.post('/valider-presence', presenceLimiter, async (req, res) => {
  try {
    const { nom, date, matiere, typeSeance, token } = req.body;
    if (!nom || !date || !matiere || !typeSeance || !token)
      return res.status(400).json({ error: "Données incomplètes." });

    const studentIP = getClientIP(req);
    console.log(`📲 Tentative de présence — Nom: "${nom}" | IP: ${studentIP} | Séance: ${typeSeance}`);

    // ── 1. Séance existe ?
    const seance = await Seance.findOne({ date, matiere });
    if (!seance)
      return res.status(400).json({ error: "Séance introuvable. Vérifiez la matière et la date." });

    const ipField = typeSeance === "Seance 1" ? 's1' : 's2';

    // Fonction helper pour logger les blocages
    const bloquer = async (raison, code = 403) => {
      console.warn(`🚫 BLOQUÉ [${studentIP}] — ${raison}`);
      seance.tentativesBloquees.push({ ip: studentIP, raison });
      await seance.save().catch(() => {});
      return res.status(code).json({ error: raison });
    };

    // ── 2. Token valide ?
    if (!token || seance.token !== token)
      return bloquer("QR Code invalide. Demandez au professeur de renouveler le code.");

    // ── 3. Token non expiré ?
    if (new Date() > new Date(seance.tokenExpiry))
      return bloquer("QR Code expiré. Demandez au professeur de renouveler le code.");

    // ── 4. Même sous-réseau WiFi que le prof ?
    if (!memeSousReseau(studentIP, seance.professorIP)) {
      return bloquer(
        `Accès refusé. Vous devez être connecté au même réseau WiFi que le professeur. ` +
        `(Votre réseau ne correspond pas.)`
      );
    }

    // ── 5. IP déjà utilisée pour ce type de séance ?
    if (!seance.ipUtilisees) seance.ipUtilisees = { s1: [], s2: [] };
    if (seance.ipUtilisees[ipField] && seance.ipUtilisees[ipField].includes(studentIP))
      return bloquer("Présence déjà enregistrée depuis cet appareil pour cette séance.", 409);

    // ── 6 & 7. Étudiant dans la liste + présence non déjà marquée
    const nomSaisi = nom.trim().toLowerCase();
    let etudiantTrouve = false;

    for (let i = 0; i < seance.etudiants.length; i++) {
      if (seance.etudiants[i].nom.toLowerCase() === nomSaisi) {
        etudiantTrouve = true;
        const champ = typeSeance === "Seance 1" ? 's1' : 's2';

        if (seance.etudiants[i][champ] === "Present")
          return bloquer("Présence déjà enregistrée pour votre nom sur cette séance.", 409);

        seance.etudiants[i][champ] = "Present";
        break;
      }
    }

    if (!etudiantTrouve)
      return bloquer("Nom introuvable dans la liste officielle.", 400);

    // ── Sauvegarder la présence ET verrouiller l'IP
    seance.ipUtilisees[ipField].push(studentIP);
    seance.markModified('etudiants');
    seance.markModified('ipUtilisees');
    await seance.save();

    console.log(`✅ Présence validée — "${nom}" | ${typeSeance} | IP: ${studentIP}`);
    res.json({ message: `✅ Présence enregistrée avec succès pour ${typeSeance} !` });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur interne." });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 3 : ARCHIVES
//  GET /archives
// ─────────────────────────────────────────────
app.get('/archives', async (req, res) => {
  try {
    const data = await Seance.find({}, '-token -tentativesBloquees -ipUtilisees').sort({ _id: -1 });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 4 : LOGS DE SÉCURITÉ (réservé prof)
//  GET /securite-logs?matiere=X&date=Y
// ─────────────────────────────────────────────
app.get('/securite-logs', async (req, res) => {
  try {
    const { matiere, date } = req.query;
    const seance = await Seance.findOne({ matiere, date });
    if (!seance) return res.status(404).json({ error: "Séance introuvable." });
    res.json({
      professorIP:         seance.professorIP,
      tokenExpiry:         seance.tokenExpiry,
      ipUtilisees:         seance.ipUtilisees,
      tentativesBloquees:  seance.tentativesBloquees
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
app.listen(10000, () => console.log('🚀 Serveur actif sur le port 10000'));