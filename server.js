require('dotenv').config();

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const crypto     = require('crypto');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const nodemailer = require('nodemailer');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────
const MONGO_URI      = process.env.MONGO_URI;
const JWT_SECRET     = process.env.JWT_SECRET;
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL;
const ADMIN_PASS     = process.env.ADMIN_PASS;
const GMAIL_USER     = process.env.GMAIL_USER;      // ex: presence.ept@gmail.com
const GMAIL_PASS     = process.env.GMAIL_PASS;      // Mot de passe d'application Gmail
const ALLOWED_DOMAIN = "ept.ucar.tn";

// ─────────────────────────────────────────────
//  CONFIGURATION NODEMAILER (Gmail SMTP)
// ─────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASS
  }
});

// Vérifier la connexion Gmail au démarrage
transporter.verify((error) => {
  if (error) {
    console.error('❌ Erreur connexion Gmail:', error.message);
  } else {
    console.log('✅ Gmail SMTP connecté — prêt à envoyer des emails');
  }
});

// ─────────────────────────────────────────────
//  CONNEXION MONGODB
// ─────────────────────────────────────────────
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
  // etudiants : { nom, email, s1, s2 }
  etudiants:   Array,
  ipUtilisees: { s1: [String], s2: [String] },
  tentativesBloquees: [{
    ip:    String,
    raison: String,
    date:  { type: Date, default: Date.now }
  }],
  // Historique des notifications email envoyées
  emailsEnvoyes: [{
    typeSeance:  String,
    envoyeA:     Date,
    nbEnvoyes:   Number,
    nbEchecs:    Number,
    nbSansEmail: Number,
    details:     Array  // [{ nom, email, statut, erreur }]
  }]
});
const Seance = mongoose.model('Seance', SeanceSchema);

// Étudiant officiel — AVEC email
const EtudiantOfficiel = mongoose.model(
  'Etudiant',
  new mongoose.Schema({
    nom:   String,
    email: String   // ex: ahmed.mhamdi@ept.ucar.tn
  }),
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
const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  message: { error: "Limite d'envoi email atteinte. Réessayez dans 1 heure." }
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

function formatDateFR(dateStr) {
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('fr-FR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
  } catch { return dateStr; }
}

// ─────────────────────────────────────────────
//  TEMPLATE EMAIL HTML PROFESSIONNEL
// ─────────────────────────────────────────────
function creerEmailHTML(etudiant, matiere, dateStr, typeSeance, profNom) {
  const dateFormatee = formatDateFR(dateStr);
  const heureEnvoi   = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const annee        = new Date().getFullYear();
  const numSeance    = typeSeance === "Seance 1" ? "1" : "2";
  const couleurSeance = typeSeance === "Seance 1" ? "#00d4ff" : "#7c3aed";

  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Notification d'absence — EPT</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">

  <!-- WRAPPER -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

          <!-- HEADER -->
          <tr>
            <td style="background:linear-gradient(135deg,#07090f 0%,#0f1623 100%);border-radius:16px 16px 0 0;padding:40px 40px 30px;text-align:center;">
              <div style="display:inline-block;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);border-radius:50%;width:72px;height:72px;line-height:72px;font-size:32px;margin-bottom:20px;">⚠️</div>
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:800;letter-spacing:-0.5px;">Absence Enregistrée</h1>
              <p style="margin:8px 0 0;color:#64748b;font-size:13px;font-family:'Courier New',monospace;letter-spacing:1px;text-transform:uppercase;">École Polytechnique de Tunisie</p>
            </td>
          </tr>

          <!-- BADGE SÉANCE -->
          <tr>
            <td style="background:#0f1623;padding:0 40px;">
              <div style="text-align:center;padding:16px 0;border-bottom:1px solid #1a2540;">
                <span style="display:inline-block;background:${couleurSeance}20;border:1px solid ${couleurSeance}50;color:${couleurSeance};font-family:'Courier New',monospace;font-size:12px;font-weight:700;padding:6px 20px;border-radius:99px;letter-spacing:2px;text-transform:uppercase;">
                  SÉANCE ${numSeance}
                </span>
              </div>
            </td>
          </tr>

          <!-- MESSAGE PRINCIPAL -->
          <tr>
            <td style="background:#0f1623;padding:32px 40px 24px;">
              <p style="margin:0 0 8px;color:#94a3b8;font-size:13px;font-family:'Courier New',monospace;letter-spacing:1px;text-transform:uppercase;">Bonjour,</p>
              <h2 style="margin:0 0 20px;color:#e2e8f0;font-size:20px;font-weight:800;">${etudiant.nom}</h2>
              <p style="margin:0;color:#94a3b8;font-size:15px;line-height:1.7;">
                Votre absence a été enregistrée automatiquement lors de la séance suivante.
                Si vous étiez présent(e), veuillez contacter votre professeur dans les plus brefs délais.
              </p>
            </td>
          </tr>

          <!-- DÉTAILS DE LA SÉANCE -->
          <tr>
            <td style="background:#0f1623;padding:0 40px 32px;">
              <div style="background:#07090f;border:1px solid #1a2540;border-radius:12px;overflow:hidden;">

                <div style="padding:14px 20px;border-bottom:1px solid #1a2540;display:flex;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="color:#64748b;font-size:12px;font-family:'Courier New',monospace;text-transform:uppercase;letter-spacing:1px;width:40%;">📚 Matière</td>
                      <td style="color:#e2e8f0;font-size:14px;font-weight:700;">${matiere}</td>
                    </tr>
                  </table>
                </div>

                <div style="padding:14px 20px;border-bottom:1px solid #1a2540;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="color:#64748b;font-size:12px;font-family:'Courier New',monospace;text-transform:uppercase;letter-spacing:1px;width:40%;">📅 Date</td>
                      <td style="color:#e2e8f0;font-size:14px;font-weight:600;">${dateFormatee}</td>
                    </tr>
                  </table>
                </div>

                <div style="padding:14px 20px;border-bottom:1px solid #1a2540;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="color:#64748b;font-size:12px;font-family:'Courier New',monospace;text-transform:uppercase;letter-spacing:1px;width:40%;">⏰ Séance</td>
                      <td>
                        <span style="display:inline-block;background:${couleurSeance}20;color:${couleurSeance};font-family:'Courier New',monospace;font-size:12px;font-weight:700;padding:3px 12px;border-radius:99px;border:1px solid ${couleurSeance}40;">
                          Séance ${numSeance}
                        </span>
                      </td>
                    </tr>
                  </table>
                </div>

                <div style="padding:14px 20px;border-bottom:1px solid #1a2540;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="color:#64748b;font-size:12px;font-family:'Courier New',monospace;text-transform:uppercase;letter-spacing:1px;width:40%;">👨‍🏫 Professeur</td>
                      <td style="color:#e2e8f0;font-size:14px;font-weight:600;">${profNom}</td>
                    </tr>
                  </table>
                </div>

                <div style="padding:14px 20px;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="color:#64748b;font-size:12px;font-family:'Courier New',monospace;text-transform:uppercase;letter-spacing:1px;width:40%;">🕐 Notifié à</td>
                      <td style="color:#e2e8f0;font-size:14px;">${heureEnvoi}</td>
                    </tr>
                  </table>
                </div>

              </div>
            </td>
          </tr>

          <!-- STATUT ABSENCE -->
          <tr>
            <td style="background:#0f1623;padding:0 40px 32px;">
              <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:12px;padding:20px;text-align:center;">
                <div style="font-size:28px;margin-bottom:8px;">🔴</div>
                <div style="color:#ef4444;font-family:'Courier New',monospace;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">STATUT : ABSENT(E)</div>
                <div style="color:#64748b;font-size:12px;margin-top:6px;">pour la ${typeSeance} du ${dateFormatee}</div>
              </div>
            </td>
          </tr>

          <!-- MESSAGE ACTION -->
          <tr>
            <td style="background:#0f1623;padding:0 40px 32px;">
              <div style="background:rgba(0,212,255,0.05);border:1px solid rgba(0,212,255,0.15);border-radius:12px;padding:20px;">
                <p style="margin:0 0 10px;color:#00d4ff;font-family:'Courier New',monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;">ℹ️ Que faire ?</p>
                <ul style="margin:0;padding-left:18px;color:#94a3b8;font-size:13px;line-height:2;">
                  <li>Si vous étiez présent(e), contactez <strong style="color:#e2e8f0;">${profNom}</strong> immédiatement</li>
                  <li>Si votre absence est justifiée, fournissez un justificatif officiel</li>
                  <li>Toute absence non justifiée sera comptabilisée dans votre dossier</li>
                </ul>
              </div>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="background:#07090f;border-radius:0 0 16px 16px;padding:24px 40px;text-align:center;border-top:1px solid #1a2540;">
              <p style="margin:0 0 6px;color:#334155;font-size:12px;font-family:'Courier New',monospace;letter-spacing:1px;">
                SYSTÈME DE PRÉSENCE AUTOMATIQUE — EPT
              </p>
              <p style="margin:0;color:#1e2d45;font-size:11px;">
                © ${annee} École Polytechnique de Tunisie · Ce message est généré automatiquement
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
}

// ─────────────────────────────────────────────
//  TEMPLATE EMAIL TEXTE BRUT (fallback)
// ─────────────────────────────────────────────
function creerEmailTexte(etudiant, matiere, dateStr, typeSeance, profNom) {
  const dateFormatee = formatDateFR(dateStr);
  const heureEnvoi   = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return `
EPT — Système de Présence Automatique
======================================

Bonjour ${etudiant.nom},

Votre absence a été enregistrée pour :

  Matière   : ${matiere}
  Date      : ${dateFormatee}
  Séance    : ${typeSeance}
  Professeur: ${profNom}
  Notifié à : ${heureEnvoi}

STATUT : ABSENT(E)

Si vous étiez présent(e), contactez votre professeur immédiatement.
Si votre absence est justifiée, fournissez un justificatif officiel.

--------------------------------------
École Polytechnique de Tunisie
Ce message est généré automatiquement.
  `.trim();
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
    if (!prof) return res.status(401).json({ error: "Email ou mot de passe incorrect." });

    const ok = await bcrypt.compare(password, prof.password);
    if (!ok) return res.status(401).json({ error: "Email ou mot de passe incorrect." });

    const token = jwt.sign(
      { id: prof._id, nom: prof.nom, email: prof.email, matiere: prof.matiere, role: 'prof' },
      JWT_SECRET, { expiresIn: '8h' }
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
      profId: req.prof.id, nom: req.prof.nom,
      email: req.prof.email, matiere: req.prof.matiere,
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

      const etudiants = inscrits.map(e => ({
        nom:   e.nom,
        email: e.email || null,
        s1:    "Absent",
        s2:    "Absent"
      }));

      seance = new Seance({
        matiere, date,
        profId: req.prof.id, profNom: req.prof.nom,
        professorIP, token, tokenExpiry: expiry,
        etudiants,
        ipUtilisees: { s1: [], s2: [] },
        tentativesBloquees: [],
        emailsEnvoyes: []
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

    if (seance.token !== token)           return bloquer("QR Code invalide.");
    if (new Date() > new Date(seance.tokenExpiry)) return bloquer("QR Code expiré.");
    if (!memeSousReseau(studentIP, seance.professorIP))
      return bloquer("Vous devez être sur le même réseau WiFi que le professeur.");
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
//  ROUTE 7 : ENVOYER EMAILS AUX ABSENTS ★
//  POST /prof/notifier-absents
//  Body : { date, typeSeance }
// ─────────────────────────────────────────────
app.post('/prof/notifier-absents', authProf, emailLimiter, async (req, res) => {
  try {
    const { date, typeSeance } = req.body;
    const matiere  = req.prof.matiere;
    const profNom  = req.prof.nom;

    if (!date || !typeSeance)
      return res.status(400).json({ error: "Date et type de séance requis." });

    const seance = await Seance.findOne({ matiere, date });
    if (!seance)
      return res.status(404).json({ error: "Séance introuvable." });

    const champ = typeSeance === "Seance 1" ? 's1' : 's2';

    // Séparer absents avec email / sans email
    const absentsAvecEmail  = seance.etudiants.filter(e => e[champ] === "Absent" && e.email);
    const absentsSansEmail  = seance.etudiants.filter(e => e[champ] === "Absent" && !e.email);

    if (absentsAvecEmail.length === 0) {
      return res.json({
        message:     "Aucun absent avec adresse email à notifier.",
        nbEnvoyes:   0,
        nbEchecs:    0,
        nbSansEmail: absentsSansEmail.length,
        details:     []
      });
    }

    const resultats = [];

    // Envoyer un email à chaque étudiant absent
    for (const etudiant of absentsAvecEmail) {
      try {
        await transporter.sendMail({
          from:    `"EPT — Présence" <${GMAIL_USER}>`,
          to:      etudiant.email,
          subject: `⚠️ Absence enregistrée — ${matiere} · ${typeSeance} · ${date}`,
          text:    creerEmailTexte(etudiant, matiere, date, typeSeance, profNom),
          html:    creerEmailHTML(etudiant, matiere, date, typeSeance, profNom)
        });

        console.log(`✅ Email envoyé → ${etudiant.nom} (${etudiant.email})`);
        resultats.push({ nom: etudiant.nom, email: etudiant.email, statut: 'envoyé' });

      } catch (emailErr) {
        console.error(`❌ Email échoué → ${etudiant.nom} :`, emailErr.message);
        resultats.push({
          nom:    etudiant.nom,
          email:  etudiant.email,
          statut: 'echec',
          erreur: emailErr.message
        });
      }
    }

    const nbEnvoyes = resultats.filter(r => r.statut === 'envoyé').length;
    const nbEchecs  = resultats.filter(r => r.statut === 'echec').length;

    // Sauvegarder l'historique dans la séance
    if (!seance.emailsEnvoyes) seance.emailsEnvoyes = [];
    seance.emailsEnvoyes.push({
      typeSeance,
      envoyeA:     new Date(),
      nbEnvoyes,
      nbEchecs,
      nbSansEmail: absentsSansEmail.length,
      details:     resultats
    });
    seance.markModified('emailsEnvoyes');
    await seance.save();

    console.log(`📧 Résumé : ${nbEnvoyes} envoyés, ${nbEchecs} échecs, ${absentsSansEmail.length} sans email`);

    res.json({
      message:     `📧 ${nbEnvoyes} email(s) envoyé(s) avec succès.`,
      nbEnvoyes,
      nbEchecs,
      nbSansEmail: absentsSansEmail.length,
      details:     resultats
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de l'envoi des emails." });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 8 : MES SÉANCES (PROF)
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
//  ROUTE 9 : LOGS SÉCURITÉ
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
    const seances = await Seance.find({}, 'etudiants emailsEnvoyes');
    let totalPresentsS1 = 0, totalPresentsS2 = 0, totalEtudiants = 0, totalEmails = 0;
    seances.forEach(s => {
      totalEtudiants  += s.etudiants.length;
      totalPresentsS1 += s.etudiants.filter(e => e.s1 === "Present").length;
      totalPresentsS2 += s.etudiants.filter(e => e.s2 === "Present").length;
      (s.emailsEnvoyes || []).forEach(n => { totalEmails += n.nbEnvoyes; });
    });
    res.json({ nbProfs, nbSeances, nbPresencesProfs, totalPresentsS1, totalPresentsS2, totalEtudiants, totalEmails });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
app.listen(10000, () => console.log('🚀 Serveur actif sur le port 10000'));
