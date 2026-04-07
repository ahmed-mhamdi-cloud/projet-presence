const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const app = express();

// Configuration de base
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- CONNEXION MONGODB (VOTRE LIEN CORRIGÉ) ---
const mongoURI = "mongodb+srv://ahmedmhamdi_db_user:75Deu32ZXLW7H4vn@cluster0.nku2lm5.mongodb.net/presence_db?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(mongoURI)
  .then(() => console.log("✅ Félicitations : Connecté à MongoDB Atlas !"))
  .catch(err => console.log("❌ Erreur de connexion :", err));

// --- MODÈLES DE DONNÉES ---

// Modèle pour stocker l'historique de chaque cours
const SeanceSchema = new mongoose.Schema({
    matiere: String,
    date: String,
    etudiants: Array // Liste des étudiants avec leur statut (Présent/Absent)
});
const Seance = mongoose.model('Seance', SeanceSchema);

// Modèle pour lire votre liste d'étudiants officiels (collection existante)
const EtudiantOfficiel = mongoose.model('Etudiant', new mongoose.Schema({ nom: String }), 'etudiants_inscrits');

// --- ROUTES API ---

// 1. Créer une nouvelle séance (déclenché par le bouton "Démarrer l'appel")
app.post('/demarrer-seance', async (req, res) => {
    try {
        const { matiere, date } = req.body;
        const listeBase = await EtudiantOfficiel.find();
        
        // On prépare la liste : tout le monde est absent par défaut
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
        console.log(`📖 Nouvelle séance créée : ${matiere} le ${date}`);
        res.json({ message: "Séance créée et sauvegardée !", id: nouvelleSeance._id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Erreur lors de la création de la séance" });
    }
});

// 2. Valider une présence (quand l'étudiant scanne le QR Code)
app.post('/valider-presence', async (req, res) => {
    try {
        const { nom, date } = req.body;
        // Met à jour le statut de l'étudiant dans la séance correspondante
        await Seance.updateOne(
            { date: date, "etudiants.nom": nom },
            { $set: { "etudiants.$.statut": "Présent", "etudiants.$.heure": new Date().toLocaleTimeString() } }
        );
        res.json({ message: "Présence enregistrée avec succès !" });
    } catch (err) {
        res.status(500).json({ error: "Erreur de validation" });
    }
});

// 3. Voir toutes les archives des cours (Lien direct pour le prof)
app.get('/archives', async (req, res) => {
    try {
        const toutesLesSeances = await Seance.find().sort({ date: -1 });
        res.json(toutesLesSeances);
    } catch (err) {
        res.status(500).json({ error: "Impossible de lire les archives" });
    }
});

// 4. Route pour charger la liste initiale sur l'interface
app.get('/liste-officielle', async (req, res) => {
    const etudiants = await EtudiantOfficiel.find();
    res.json(etudiants);
});

// Lancement du serveur
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur actif sur le port ${PORT}`);
});