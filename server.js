const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- CONNEXION MONGODB ---
// Votre lien avec le mot de passe inclus
const mongoURI = "mongodb+srv://ahmedmhamdi_db_user:75Deu32ZXLW7H4vn@cluster0.nku2lm5.mongodb.net/presence_db?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(mongoURI)
  .then(() => console.log("✅ Félicitations : Connecté à MongoDB Atlas !"))
  .catch(err => console.log("❌ Erreur de connexion :", err));

// --- MODÈLES ---
const Seance = mongoose.model('Seance', new mongoose.Schema({
    matiere: String,
    date: String,
    etudiants: Array
}));

const EtudiantOfficiel = mongoose.model('Etudiant', new mongoose.Schema({ nom: String }), 'etudiants_inscrits');

// --- ROUTES ---
app.post('/demarrer-seance', async (req, res) => {
    const { matiere, date } = req.body;
    const listeBase = await EtudiantOfficiel.find();
    const etudiantsInitial = listeBase.map(e => ({ nom: e.nom, statut: "Absent", heure: "--:--" }));
    const nouvelleSeance = new Seance({ matiere, date, etudiants: etudiantsInitial });
    await nouvelleSeance.save();
    res.json({ message: "Séance créée !" });
});

app.post('/valider-presence', async (req, res) => {
    const { nom, date } = req.body;
    await Seance.updateOne(
        { date: date, "etudiants.nom": nom },
        { $set: { "etudiants.$.statut": "Présent", "etudiants.$.heure": new Date().toLocaleTimeString() } }
    );
    res.json({ message: "Présence validée !" });
});

app.get('/archives', async (req, res) => {
    const seances = await Seance.find().sort({ _id: -1 });
    res.json(seances);
});

app.get('/liste-officielle', async (req, res) => {
    const etudiants = await EtudiantOfficiel.find();
    res.json(etudiants);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Serveur actif sur le port ${PORT}`));