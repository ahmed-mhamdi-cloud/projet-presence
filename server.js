const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const app = express();

// Configuration
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- CONNEXION MONGODB (CORRIGÉE) ---
// Ce lien contient votre utilisateur, votre mot de passe et le nom de la base 'presence_db'
const mongoURI = "mongodb+srv://ahmedmhamdi_db_user:75Deu32ZXLW7H4vn@cluster0.nku2lm5.mongodb.net/presence_db?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(mongoURI)
  .then(() => console.log("✅ Félicitations : Connecté à MongoDB Atlas !"))
  .catch(err => console.log("❌ Erreur de connexion MongoDB :", err));

// --- MODÈLES DE DONNÉES ---

// Modèle pour stocker l'historique de chaque séance de cours
const SeanceSchema = new mongoose.Schema({
    matiere: String,
    date: String,
    etudiants: Array // Liste des étudiants avec statut (Présent/Absent)
});
const Seance = mongoose.model('Seance', SeanceSchema);

// Modèle pour lire votre liste d'étudiants inscrits
const EtudiantOfficiel = mongoose.model('Etudiant', new mongoose.Schema({ nom: String }), 'etudiants_inscrits');

// --- ROUTES API ---

// 1. Démarrer une nouvelle séance (Sauvegarde dans MongoDB)
app.post('/demarrer-seance', async (req, res) => {
    try {
        const { matiere, date } = req.body;
        const listeBase = await EtudiantOfficiel.find();
        
        // Initialisation : Tout le monde est "Absent" au début
        const etudiantsInitial = listeBase.map(e => ({
            nom: e.nom,
            statut: "Absent",
            heure: "--:--"
        }));

        const nouvelleSeance = new Seance({
            matiere,
            date,
            etudiants: etudiantsInitial
        });

        await nouvelleSeance.save();
        console.log(`📖 Séance de ${matiere} créée pour le ${date}`);
        res.json({ message: "Séance enregistrée dans la base !", id: nouvelleSeance._id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Valider une présence (Scan QR Code)
app.post('/valider-presence', async (req, res) => {
    try {
        const { nom, date } = req.body;
        // Met à jour l'étudiant dans la séance du jour
        await Seance.updateOne(
            { date: date, "etudiants.nom": nom },
            { $set: { "etudiants.$.statut": "Présent", "etudiants.$.heure": new Date().toLocaleTimeString() } }
        );
        res.json({ message: "Présence enregistrée !" });
    } catch (err) {
        res.status(500).json({ error: "Erreur lors du scan" });
    }
});

// 3. Récupérer toutes les archives (pour la page archives.html)
app.get('/archives', async (req, res) => {
    try {
        const seances = await Seance.find().sort({ _id: -1 }); // Les plus récentes en premier
        res.json(seances);
    } catch (err) {
        res.status(500).json({ error: "Erreur lecture archives" });
    }
});

// 4. Charger la liste des étudiants au chargement du tableau
app.get('/liste-officielle', async (req, res) => {
    const etudiants = await EtudiantOfficiel.find();
    res.json(etudiants);
});

// Lancement du serveur
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur en ligne sur le port ${PORT}`);
});