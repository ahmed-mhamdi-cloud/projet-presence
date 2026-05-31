require('dotenv').config();

const express   = require('express');
const mongoose  = require('mongoose');
const cors      = require('cors');
const crypto    = require('crypto');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Resend } = require('resend');

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
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALLOWED_DOMAIN = "ept.ucar.tn";

// Client Resend
const resend = new Resend(RESEND_API_KEY);
console.log('✅ Resend initialisé — prêt à envoyer des emails');

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
  etudiants:   Array,  // { nom, email, s1, s2 }
  ipUtilisees: { s1: [String], s2: [String] },
  // Workflow : 'active' → séances en cours | 'finalisee' → sauvegardées
  statut:          { type: String, default: 'active' },
  // Quelles séances ont été ouvertes (QR généré)
  seancesOuvertes: { s1: { type: Boolean, default: false }, s2: { type: Boolean, default: false } },
  tentativesBloquees: [{
    ip:    String,
    raison: String,
    date:  { type: Date, default: Date.now }
  }],
  emailsEnvoyes: [{
    typeSeance:  String,
    envoyeA:     Date,
    nbEnvoyes:   Number,
    nbEchecs:    Number,
    nbSansEmail: Number,
    details:     Array
  }]
});
const Seance = mongoose.model('Seance', SeanceSchema);

const EtudiantOfficiel = mongoose.model(
  'Etudiant',
  new mongoose.Schema({ nom: String, email: String }),
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
//  TEMPLATE EMAIL HTML
// ─────────────────────────────────────────────
function creerEmailHTML(etudiant, matiere, dateStr, typeSeance, profNom) {
  const dateFormatee  = formatDateFR(dateStr);
  const heureEnvoi    = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const annee         = new Date().getFullYear();
  const numSeance     = typeSeance === "Seance 1" ? "1" : "2";
  const couleur       = typeSeance === "Seance 1" ? "#00d4ff" : "#7c3aed";

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 20px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

      <!-- HEADER -->
      <tr><td style="background:#07090f;border-radius:16px 16px 0 0;padding:40px;text-align:center;">
        <div style="font-size:48px;margin-bottom:16px;">⚠️</div>
        <h1 style="margin:0;color:#fff;font-size:24px;font-weight:800;">Absence Enregistrée</h1>
        <p style="margin:8px 0 0;color:#64748b;font-size:12px;letter-spacing:2px;text-transform:uppercase;">École Polytechnique de Tunisie</p>
      </td></tr>

      <!-- BADGE SÉANCE -->
      <tr><td style="background:#0f1623;padding:16px;text-align:center;border-bottom:1px solid #1a2540;">
        <span style="background:${couleur}20;border:1px solid ${couleur}50;color:${couleur};font-size:12px;font-weight:700;padding:6px 20px;border-radius:99px;letter-spacing:2px;">
          SÉANCE ${numSeance}
        </span>
      </td></tr>

      <!-- BONJOUR -->
      <tr><td style="background:#0f1623;padding:32px 40px 24px;">
        <p style="margin:0 0 4px;color:#94a3b8;font-size:13px;text-transform:uppercase;letter-spacing:1px;">Bonjour,</p>
        <h2 style="margin:0 0 16px;color:#e2e8f0;font-size:20px;font-weight:800;">${etudiant.nom}</h2>
        <p style="margin:0;color:#94a3b8;font-size:15px;line-height:1.7;">
          Votre absence a été enregistrée automatiquement. Si vous étiez présent(e), contactez votre professeur immédiatement.
        </p>
      </td></tr>

      <!-- DÉTAILS -->
      <tr><td style="background:#0f1623;padding:0 40px 32px;">
        <div style="background:#07090f;border:1px solid #1a2540;border-radius:12px;overflow:hidden;">

          <table width="100%" cellpadding="0" cellspacing="0">
            <tr style="border-bottom:1px solid #1a2540;">
              <td style="padding:14px 20px;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:1px;width:40%;">📚 Matière</td>
              <td style="padding:14px 20px;color:#e2e8f0;font-size:14px;font-weight:700;">${matiere}</td>
            </tr>
            <tr style="border-bottom:1px solid #1a2540;">
              <td style="padding:14px 20px;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:1px;">📅 Date</td>
              <td style="padding:14px 20px;color:#e2e8f0;font-size:14px;font-weight:600;">${dateFormatee}</td>
            </tr>
            <tr style="border-bottom:1px solid #1a2540;">
              <td style="padding:14px 20px;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:1px;">⏰ Séance</td>
              <td style="padding:14px 20px;">
                <span style="background:${couleur}20;color:${couleur};font-size:12px;font-weight:700;padding:3px 12px;border-radius:99px;border:1px solid ${couleur}40;">
                  Séance ${numSeance}
                </span>
              </td>
            </tr>
            <tr style="border-bottom:1px solid #1a2540;">
              <td style="padding:14px 20px;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:1px;">👨‍🏫 Professeur</td>
              <td style="padding:14px 20px;color:#e2e8f0;font-size:14px;font-weight:600;">${profNom}</td>
            </tr>
            <tr>
              <td style="padding:14px 20px;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:1px;">🕐 Notifié à</td>
              <td style="padding:14px 20px;color:#e2e8f0;font-size:14px;">${heureEnvoi}</td>
            </tr>
          </table>

        </div>
      </td></tr>

      <!-- STATUT -->
      <tr><td style="background:#0f1623;padding:0 40px 32px;">
        <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:12px;padding:20px;text-align:center;">
          <div style="font-size:28px;margin-bottom:8px;">🔴</div>
          <div style="color:#ef4444;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">STATUT : ABSENT(E)</div>
          <div style="color:#64748b;font-size:12px;margin-top:6px;">pour la Séance ${numSeance} du ${dateFormatee}</div>
        </div>
      </td></tr>

      <!-- QUE FAIRE -->
      <tr><td style="background:#0f1623;padding:0 40px 32px;">
        <div style="background:rgba(0,212,255,0.05);border:1px solid rgba(0,212,255,0.15);border-radius:12px;padding:20px;">
          <p style="margin:0 0 10px;color:#00d4ff;font-size:11px;letter-spacing:1px;text-transform:uppercase;">ℹ️ Que faire ?</p>
          <ul style="margin:0;padding-left:18px;color:#94a3b8;font-size:13px;line-height:2;">
            <li>Si vous étiez présent(e), contactez <strong style="color:#e2e8f0;">${profNom}</strong> immédiatement</li>
            <li>Si votre absence est justifiée, fournissez un justificatif officiel</li>
            <li>Toute absence non justifiée sera comptabilisée dans votre dossier</li>
          </ul>
        </div>
      </td></tr>

      <!-- FOOTER -->
      <tr><td style="background:#07090f;border-radius:0 0 16px 16px;padding:24px 40px;text-align:center;border-top:1px solid #1a2540;">
        <p style="margin:0 0 4px;color:#334155;font-size:12px;letter-spacing:1px;">SYSTÈME DE PRÉSENCE AUTOMATIQUE — EPT</p>
        <p style="margin:0;color:#1e2d45;font-size:11px;">© ${annee} École Polytechnique de Tunisie · Message généré automatiquement</p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
//  ROUTE 4b : ÉTAT DE LA JOURNÉE DU PROF
//  GET /prof/etat-journee
//  Retourne : presencePointee, seanceActive, seance1Ouverte, seance2Ouverte, seanceFinalisee
// ─────────────────────────────────────────────
app.get('/prof/etat-journee', authProf, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Vérifier si présence du prof pointée aujourd'hui
    const presencePointee = !!(await PresenceProf.findOne({ profId: req.prof.id, date: today }));

    // Vérifier s'il y a des séances non finalisées d'un AUTRE jour (bloque)
    const seanceNonFinaliseeAutreJour = await Seance.findOne({
      profId: req.prof.id,
      date:   { $ne: today },
      statut: 'active'
    });

    // Séance d'aujourd'hui
    const seanceAujourdhui = await Seance.findOne({ matiere: req.prof.matiere, date: today, profId: req.prof.id });

    res.json({
      presencePointee,
      seanceNonFinaliseeAutreJour: seanceNonFinaliseeAutreJour
        ? { date: seanceNonFinaliseeAutreJour.date, matiere: seanceNonFinaliseeAutreJour.matiere }
        : null,
      seance1Ouverte:   seanceAujourdhui?.seancesOuvertes?.s1 || false,
      seance2Ouverte:   seanceAujourdhui?.seancesOuvertes?.s2 || false,
      seanceFinalisee:  seanceAujourdhui?.statut === 'finalisee' || false,
      seanceId:         seanceAujourdhui?._id || null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
//  ROUTE 5 : DÉMARRER UNE SÉANCE
// ─────────────────────────────────────────────
app.post('/demarrer-seance', authProf, async (req, res) => {
  try {
    const { date, typeSeance } = req.body;
    const matiere  = req.prof.matiere;
    if (!date || !typeSeance) return res.status(400).json({ error: "Date et type de séance requis." });

    const today = new Date().toISOString().split('T')[0];

    // ── 1. Vérifier que la présence du prof est pointée aujourd'hui
    const presencePointee = await PresenceProf.findOne({ profId: req.prof.id, date: today });
    if (!presencePointee)
      return res.status(403).json({ error: "Vous devez d'abord valider votre présence du jour avant de démarrer une séance." });

    // ── 2. Vérifier qu'il n'y a pas de séances non finalisées d'un autre jour
    const seanceNonFinalisee = await Seance.findOne({
      profId: req.prof.id,
      date:   { $ne: date },
      statut: 'active'
    });
    if (seanceNonFinalisee)
      return res.status(403).json({
        error: `Vous avez des séances non sauvegardées du ${seanceNonFinalisee.date}. Finalisez-les avant d'en démarrer de nouvelles.`
      });

    const professorIP = getClientIP(req);
    const { token, expiry } = genererToken(15);

    let seance = await Seance.findOne({ matiere, date, profId: req.prof.id });

    if (!seance) {
      // ── 3. Séance 2 ne peut pas démarrer sans Séance 1
      if (typeSeance === "Seance 2")
        return res.status(403).json({ error: "Vous devez d'abord démarrer la Séance 1." });

      const inscrits = await EtudiantOfficiel.find();
      if (inscrits.length === 0)
        return res.status(400).json({ error: "Aucun étudiant dans la base." });

      const etudiants = inscrits.map(e => ({
        nom: e.nom, email: e.email || null, s1: "Absent", s2: "Absent"
      }));

      seance = new Seance({
        matiere, date, profId: req.prof.id, profNom: req.prof.nom,
        professorIP, token, tokenExpiry: expiry,
        etudiants, ipUtilisees: { s1: [], s2: [] },
        tentativesBloquees: [], emailsEnvoyes: [],
        statut: 'active',
        seancesOuvertes: { s1: false, s2: false }
      });
    } else {
      // ── 4. Séance finalisée → ne peut plus être modifiée
      if (seance.statut === 'finalisee')
        return res.status(403).json({ error: "Ces séances sont déjà finalisées et sauvegardées." });

      // ── 5. Séance 2 nécessite Séance 1 ouverte
      if (typeSeance === "Seance 2" && !seance.seancesOuvertes?.s1)
        return res.status(403).json({ error: "Vous devez d'abord démarrer la Séance 1." });

      seance.professorIP = professorIP;
      seance.token       = token;
      seance.tokenExpiry = expiry;
    }

    // Marquer la séance comme ouverte
    if (!seance.seancesOuvertes) seance.seancesOuvertes = { s1: false, s2: false };
    if (typeSeance === "Seance 1") seance.seancesOuvertes.s1 = true;
    if (typeSeance === "Seance 2") seance.seancesOuvertes.s2 = true;

    seance.markModified('seancesOuvertes');
    await seance.save();

    res.json({
      message:    "Séance prête.",
      token,
      expiry:     expiry.toISOString(),
      matiere,
      typeSeance,
      s1Ouverte:  seance.seancesOuvertes.s1,
      s2Ouverte:  seance.seancesOuvertes.s2
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
//  ROUTE 5b : FINALISER LES 2 SÉANCES
//  POST /prof/finaliser-seances
//  Body : { date }
// ─────────────────────────────────────────────
app.post('/prof/finaliser-seances', authProf, async (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: "Date requise." });

    const seance = await Seance.findOne({ matiere: req.prof.matiere, date, profId: req.prof.id });
    if (!seance)
      return res.status(404).json({ error: "Séance introuvable." });

    if (seance.statut === 'finalisee')
      return res.status(409).json({ error: "Ces séances sont déjà finalisées." });

    if (!seance.seancesOuvertes?.s1 || !seance.seancesOuvertes?.s2)
      return res.status(403).json({ error: "Vous devez démarrer les 2 séances avant de finaliser." });

    seance.statut = 'finalisee';
    await seance.save();

    const presents1 = seance.etudiants.filter(e => e.s1 === "Present").length;
    const presents2 = seance.etudiants.filter(e => e.s2 === "Present").length;
    const total     = seance.etudiants.length;

    console.log(`✅ Séances finalisées : ${req.prof.matiere} | ${date} | S1: ${presents1}/${total} | S2: ${presents2}/${total}`);

    res.json({
      message:   "✅ Les 2 séances ont été sauvegardées avec succès !",
      presents1, presents2, total,
      date,      matiere: req.prof.matiere
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    if (!seance) return res.status(400).json({ error: "Séance introuvable." });

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
  } catch (err) { res.status(500).json({ error: "Erreur serveur." }); }
});

// ─────────────────────────────────────────────
//  ROUTE 7 : ENVOYER EMAILS AUX ABSENTS ★
// ─────────────────────────────────────────────
app.post('/prof/notifier-absents', authProf, emailLimiter, async (req, res) => {
  try {
    const { date, typeSeance } = req.body;
    const matiere = req.prof.matiere;
    const profNom = req.prof.nom;

    if (!date || !typeSeance)
      return res.status(400).json({ error: "Date et type de séance requis." });

    const seance = await Seance.findOne({ matiere, date });
    if (!seance) return res.status(404).json({ error: "Séance introuvable." });

    const champ = typeSeance === "Seance 1" ? 's1' : 's2';
    const absentsAvecEmail = seance.etudiants.filter(e => e[champ] === "Absent" && e.email);
    const absentsSansEmail = seance.etudiants.filter(e => e[champ] === "Absent" && !e.email);

    if (absentsAvecEmail.length === 0) {
      return res.json({
        message: "Aucun absent avec adresse email à notifier.",
        nbEnvoyes: 0, nbEchecs: 0,
        nbSansEmail: absentsSansEmail.length, details: []
      });
    }

    const resultats = [];

    for (const etudiant of absentsAvecEmail) {
      try {
        await resend.emails.send({
          from:    'EPT Présence <onboarding@resend.dev>',
          to:      etudiant.email,
          subject: `⚠️ Absence — ${matiere} · ${typeSeance} · ${date}`,
          html:    creerEmailHTML(etudiant, matiere, date, typeSeance, profNom)
        });

        console.log(`✅ Email envoyé → ${etudiant.nom} (${etudiant.email})`);
        resultats.push({ nom: etudiant.nom, email: etudiant.email, statut: 'envoyé' });

      } catch (err) {
        console.error(`❌ Email échoué → ${etudiant.nom} :`, err.message);
        resultats.push({ nom: etudiant.nom, email: etudiant.email, statut: 'echec', erreur: err.message });
      }
    }

    const nbEnvoyes = resultats.filter(r => r.statut === 'envoyé').length;
    const nbEchecs  = resultats.filter(r => r.statut === 'echec').length;

    if (!seance.emailsEnvoyes) seance.emailsEnvoyes = [];
    seance.emailsEnvoyes.push({
      typeSeance, envoyeA: new Date(),
      nbEnvoyes, nbEchecs,
      nbSansEmail: absentsSansEmail.length,
      details: resultats
    });
    seance.markModified('emailsEnvoyes');
    await seance.save();

    res.json({
      message: `📧 ${nbEnvoyes} email(s) envoyé(s) avec succès.`,
      nbEnvoyes, nbEchecs,
      nbSansEmail: absentsSansEmail.length,
      details: resultats
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de l'envoi des emails." });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 8 : MES SÉANCES
// ─────────────────────────────────────────────
app.get('/prof/mes-seances', authProf, async (req, res) => {
  try {
    const seances = await Seance
      .find({ matiere: req.prof.matiere }, '-token -tentativesBloquees -ipUtilisees')
      .sort({ _id: -1 });
    res.json(seances);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
      professorIP: seance.professorIP, tokenExpiry: seance.tokenExpiry,
      ipUtilisees: seance.ipUtilisees, tentativesBloquees: seance.tentativesBloquees
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
      Prof.countDocuments(), Seance.countDocuments(), PresenceProf.countDocuments()
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
//  ROUTES ADMIN — GESTION ÉTUDIANTS (CRUD)
// ─────────────────────────────────────────────

// GET — Liste tous les étudiants
app.get('/admin/etudiants', authAdmin, async (req, res) => {
  try {
    const data = await EtudiantOfficiel.find().sort({ nom: 1 });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST — Ajouter un étudiant
app.post('/admin/etudiants', authAdmin, async (req, res) => {
  try {
    const { nom, email, classe } = req.body;
    if (!nom) return res.status(400).json({ error: "Le nom est obligatoire." });

    // Vérifier doublon
    const existe = await EtudiantOfficiel.findOne({ nom: nom.trim().toLowerCase() });
    if (existe) return res.status(409).json({ error: "Un étudiant avec ce nom existe déjà." });

    const etudiant = new EtudiantOfficiel({
      nom:    nom.trim(),
      email:  email?.trim().toLowerCase() || null,
      classe: classe?.trim() || "Générale"
    });
    await etudiant.save();
    console.log(`✅ Étudiant ajouté : ${nom}`);
    res.status(201).json({ message: "Étudiant ajouté avec succès.", etudiant });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT — Modifier un étudiant
app.put('/admin/etudiants/:id', authAdmin, async (req, res) => {
  try {
    const { nom, email, classe } = req.body;
    if (!nom) return res.status(400).json({ error: "Le nom est obligatoire." });

    const etudiant = await EtudiantOfficiel.findByIdAndUpdate(
      req.params.id,
      {
        nom:    nom.trim(),
        email:  email?.trim().toLowerCase() || null,
        classe: classe?.trim() || "Générale"
      },
      { new: true }
    );
    if (!etudiant) return res.status(404).json({ error: "Étudiant introuvable." });
    console.log(`✏️ Étudiant modifié : ${nom}`);
    res.json({ message: "Étudiant modifié avec succès.", etudiant });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE — Supprimer un étudiant
app.delete('/admin/etudiants/:id', authAdmin, async (req, res) => {
  try {
    const etudiant = await EtudiantOfficiel.findByIdAndDelete(req.params.id);
    if (!etudiant) return res.status(404).json({ error: "Étudiant introuvable." });
    console.log(`🗑️ Étudiant supprimé : ${etudiant.nom}`);
    res.json({ message: `Étudiant "${etudiant.nom}" supprimé avec succès.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
app.listen(10000, () => console.log('🚀 Serveur actif sur le port 10000'));
