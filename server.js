require('dotenv').config();

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const crypto     = require('crypto');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─────────────────────────────────────────────
//  CONFIGURATION — valeurs lues depuis Render
// ─────────────────────────────────────────────
const MONGO_URI      = process.env.MONGO_URI;
const JWT_SECRET     = process.env.JWT_SECRET;
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL;
const ADMIN_PASS     = process.env.ADMIN_PASS;
const ALLOWED_DOMAIN = "ept.ucar.tn";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Connecté à MongoDB Atlas"))
  .catch(err => console.log("❌ Erreur MongoDB :", err));

// ─────────────────────────────────────────────
//  SCHEMAS
// ─────────────────────────────────────────────
const ProfSchema = new mongoose.Schema({
  nom:       { type: String, required: true },
  email:     { type: String, required: true, unique: true, lowercase: true },
  password:  { type: String, required: true },
  matiere:   { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const Prof = mongoose.model('Prof', ProfSchema);

const PresenceProfSchema = new mongoose.Schema({
  profId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Prof' },
  nom:     String,
  email:   String,
  matiere: String,
  date:    String,
  heure:   String,
  ip:      String
});
const PresenceProf = mongoose.model('PresenceProf', PresenceProfSchema);

const SeanceSchema = new mongoose.Schema({
  matiere:     String,
  date:        String,
  profId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Prof' },
  profNom:     String,
  professorIP: String,
  token:       String,
  tokenExpiry: Date,
  etudiants:   Array,
  ipUtilisees: { s1: [String], s2: [String] },
  tentativesBloquees: [{
    ip:    String,
    raison: String,
    date:  { type: Date, default: Date.now }
  }]
});
const Seance = mongoose.model('Seance', SeanceSchema);

const EtudiantOfficiel = mongoose.model(
  'Etudiant',
  new mongoose.Schema({ nom: String }),
  'etudiants'
);

// ─────────────────────────────────────────────
//  RATE LIMITERS
// ─────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: "Trop de tentatives. Réessayez dans 15 minutes." }
});

const presenceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: "Trop de tentatives. Réessayez dans 15 minutes." }
});

// ─────────────────────────────────────────────
//  MIDDLEWARES AUTH
// ─────────────────────────────────────────────
function authProf(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: "Token manquant." });
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'prof') return res.status(403).json({ error: "Accès refusé." });
    req.prof = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Token invalide ou expiré." });
  }
}

function authAdmin(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: "Token manquant." });
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: "Accès réservé à l'admin." });
    next();
  } catch {
    return res.status(401).json({ error: "Token invalide ou expiré." });
  }
}

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function getClientIP(req) {
  let ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
        || req.connection?.remoteAddress
        || req.ip || '0.0.0.0';
  return ip.replace(/^::ffff:/, '');
}

function memeSousReseau(ip1, ip2) {
  try {
    const p1 = ip1.replace(/^::ffff:/, '').split('.');
    const p2 = ip2.replace(/^::ffff:/, '').split('.');
    if (p1.length !== 4 || p2.length !== 4) return false;
    return p1[0] === p2[0] && p1[1] === p2[1] && p1[2] === p2[2];
  } catch { return false; }
}

function genererToken(min = 15) {
  return {
    token:  crypto.randomBytes(24).toString('hex'),
    expiry: new Date(Date.now() + min * 60 * 1000)
  };
}

// ─────────────────────────────────────────────
//  ROUTE 1 : INSCRIPTION PROFESSEUR
// ─────────────────────────────────────────────
app.post('/auth/register', authLimiter, async (req, res) => {
  try {
    const { nom, email, password, matiere } = req.body;
    if (!nom || !email || !password || !matiere)
      return res.status(400).json({ error: "Tous les champs sont requis." });

    const domain = email.split('@')[1]?.toLowerCase();
    if (domain !== ALLOWED_DOMAIN)
      return res.status(400).json({ error: `Seuls les emails @${ALLOWED_DOMAIN} sont autorisés.` });

    const existe = await Prof.findOne({ email: email.toLowerCase() });
    if (existe)
      return res.status(409).json({ error: "Un compte existe déjà avec cet email." });

    const hash = await bcrypt.hash(password, 12);
    await new Prof({ nom, email: email.toLowerCase(), password: hash, matiere }).save();

    console.log(`✅ Nouveau prof : ${nom} | ${email} | ${matiere}`);
    res.status(201).json({ message: "Compte créé avec succès. Vous pouvez vous connecter." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 2 : CONNEXION PROFESSEUR
// ─────────────────────────────────────────────
app.post('/auth/login-prof', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email et mot de passe requis." });

    const prof = await Prof.findOne({ email: email.toLowerCase() });
    if (!prof)
      return res.status(401).json({ error: "Email ou mot de passe incorrect." });

    const ok = await bcrypt.compare(password, prof.password);
    if (!ok)
      return res.status(401).json({ error: "Email ou mot de passe incorrect." });

    const token = jwt.sign(
      { id: prof._id, nom: prof.nom, email: prof.email, matiere: prof.matiere, role: 'prof' },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ token, nom: prof.nom, email: prof.email, matiere: prof.matiere });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 3 : CONNEXION ADMIN
// ─────────────────────────────────────────────
app.post('/auth/login-admin', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (email !== ADMIN_EMAIL || password !== ADMIN_PASS)
      return res.status(401).json({ error: "Identifiants admin incorrects." });

    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 4 : POINTAGE PRÉSENCE PROFESSEUR
// ─────────────────────────────────────────────
app.post('/prof/pointer-presence', authProf, async (req, res) => {
  try {
    const ip    = getClientIP(req);
    const date  = new Date().toISOString().split('T')[0];
    const heure = new Date().toLocaleTimeString('fr-FR');

    const dejaPonte = await PresenceProf.findOne({ profId: req.prof.id, date });
    if (dejaPonte)
      return res.status(409).json({ error: "Votre présence est déjà pointée pour aujourd'hui." });

    await new PresenceProf({
      profId:  req.prof.id,
      nom:     req.prof.nom,
      email:   req.prof.email,
      matiere: req.prof.matiere,
      date, heure, ip
    }).save();

    res.json({ message: `✅ Présence pointée à ${heure}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 5 : DÉMARRER UNE SÉANCE
// ─────────────────────────────────────────────
app.post('/demarrer-seance', authProf, async (req, res) => {
  try {
    const { date } = req.body;
    const matiere  = req.prof.matiere;
    if (!date) return res.status(400).json({ error: "Date requise." });

    const professorIP = getClientIP(req);
    const { token, expiry } = genererToken(15);

    let seance = await Seance.findOne({ matiere, date });
    if (!seance) {
      const inscrits = await EtudiantOfficiel.find();
      if (inscrits.length === 0)
        return res.status(400).json({ error: "Aucun étudiant dans la base." });

      const etudiants = inscrits.map(e => ({ nom: e.nom, s1: "Absent", s2: "Absent" }));
      seance = new Seance({
        matiere, date,
        profId:  req.prof.id,
        profNom: req.prof.nom,
        professorIP, token, tokenExpiry: expiry,
        etudiants,
        ipUtilisees: { s1: [], s2: [] },
        tentativesBloquees: []
      });
    } else {
      seance.professorIP = professorIP;
      seance.token       = token;
      seance.tokenExpiry = expiry;
    }

    await seance.save();
    res.json({ message: "Séance prête.", token, expiry: expiry.toISOString(), matiere });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 6 : VALIDER PRÉSENCE ÉTUDIANT
// ─────────────────────────────────────────────
app.post('/valider-presence', presenceLimiter, async (req, res) => {
  try {
    const { nom, date, matiere, typeSeance, token } = req.body;
    if (!nom || !date || !matiere || !typeSeance || !token)
      return res.status(400).json({ error: "Données incomplètes." });

    const studentIP = getClientIP(req);
    const seance    = await Seance.findOne({ date, matiere });
    if (!seance)
      return res.status(400).json({ error: "Séance introuvable." });

    const ipField = typeSeance === "Seance 1" ? 's1' : 's2';

    const bloquer = async (raison, code = 403) => {
      seance.tentativesBloquees.push({ ip: studentIP, raison });
      await seance.save().catch(() => {});
      return res.status(code).json({ error: raison });
    };

    if (seance.token !== token)
      return bloquer("QR Code invalide.");
    if (new Date() > new Date(seance.tokenExpiry))
      return bloquer("QR Code expiré. Demandez au professeur de renouveler.");
    if (!memeSousReseau(studentIP, seance.professorIP))
      return bloquer("Vous devez être connecté au même réseau WiFi que le professeur.");
    if (!seance.ipUtilisees) seance.ipUtilisees = { s1: [], s2: [] };
    if (seance.ipUtilisees[ipField]?.includes(studentIP))
      return bloquer("Présence déjà enregistrée depuis cet appareil.", 409);

    const nomSaisi = nom.trim().toLowerCase();
    let trouve = false;

    for (let i = 0; i < seance.etudiants.length; i++) {
      if (seance.etudiants[i].nom.toLowerCase() === nomSaisi) {
        const champ = typeSeance === "Seance 1" ? 's1' : 's2';
        if (seance.etudiants[i][champ] === "Present")
          return bloquer("Présence déjà enregistrée pour votre nom.", 409);
        seance.etudiants[i][champ] = "Present";
        trouve = true;
        break;
      }
    }

    if (!trouve) return bloquer("Nom introuvable dans la liste officielle.", 400);

    seance.ipUtilisees[ipField].push(studentIP);
    seance.markModified('etudiants');
    seance.markModified('ipUtilisees');
    await seance.save();

    res.json({ message: `✅ Présence enregistrée pour ${typeSeance} !` });
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 7 : ARCHIVES DU PROF (ses séances)
// ─────────────────────────────────────────────
app.get('/prof/mes-seances', authProf, async (req, res) => {
  try {
    const seances = await Seance
      .find({ matiere: req.prof.matiere }, '-token -tentativesBloquees -ipUtilisees')
      .sort({ _id: -1 });
    res.json(seances);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 8 : LOGS SÉCURITÉ
// ─────────────────────────────────────────────
app.get('/securite-logs', authProf, async (req, res) => {
  try {
    const { date } = req.query;
    const seance = await Seance.findOne({ matiere: req.prof.matiere, date });
    if (!seance) return res.status(404).json({ error: "Séance introuvable." });
    res.json({
      professorIP:        seance.professorIP,
      tokenExpiry:        seance.tokenExpiry,
      ipUtilisees:        seance.ipUtilisees,
      tentativesBloquees: seance.tentativesBloquees
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTES ADMIN
// ─────────────────────────────────────────────
app.get('/admin/seances', authAdmin, async (req, res) => {
  try {
    const data = await Seance.find({}, '-token').sort({ _id: -1 });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/presences-profs', authAdmin, async (req, res) => {
  try {
    const data = await PresenceProf.find().sort({ _id: -1 });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/profs', authAdmin, async (req, res) => {
  try {
    const data = await Prof.find({}, '-password').sort({ createdAt: -1 });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/stats', authAdmin, async (req, res) => {
  try {
    const [nbProfs, nbSeances, nbPresencesProfs] = await Promise.all([
      Prof.countDocuments(),
      Seance.countDocuments(),
      PresenceProf.countDocuments()
    ]);
    const seances = await Seance.find({}, 'etudiants');
    let totalPresentsS1 = 0, totalPresentsS2 = 0, totalEtudiants = 0;
    seances.forEach(s => {
      totalEtudiants  += s.etudiants.length;
      totalPresentsS1 += s.etudiants.filter(e => e.s1 === "Present").length;
      totalPresentsS2 += s.etudiants.filter(e => e.s2 === "Present").length;
    });
    res.json({ nbProfs, nbSeances, nbPresencesProfs, totalPresentsS1, totalPresentsS2, totalEtudiants });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
app.listen(10000, () => console.log('🚀 Serveur actif sur le port 10000'));
