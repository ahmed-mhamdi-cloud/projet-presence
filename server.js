const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Connexion MongoDB (Remplacez par VOTRE lien actuel)
mongoose.connect('VOTRE_LIEN_MONGODB_ICI', {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log("✅ Connecté à MongoDB"))
  .catch(err => console.log("❌ Erreur MongoDB:", err));

// Modèle pour les séances
const SeanceSchema = new mongoose.Schema({
    matiere: String,
    date: String,
    etudiants: Array // Contiendra la liste complète avec statuts
});
const Seance = mongoose.model('Seance', SeanceSchema);

// Modèle pour la liste officielle (vos étudiants déjà enregistrés)
const EtudiantOffciel = mongoose.model('Etudiant', new mongoose.Schema({ nom: String }), 'etudiants_inscrits');

// ROUTE 1 : Démarrer et Enregistrer une nouvelle séance
app.post('/demarrer-seance', async (req, res) => {
    const { matiere, date } = req.body;
    const listeBase = await EtudiantOffciel.find();
    
    // On prépare la liste : tout le monde est absent au début
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
    res.json({ message: "Séance créée !", id: nouvelleSeance._id });
});

// ROUTE 2 : Valider une présence dans la séance en cours
app.post('/valider-presence', async (req, res) => {
    const { nom, date } = req.body;
    // On cherche la séance du jour pour cette matière et on met à jour l'étudiant
    await Seance.updateOne(
        { date: date, "etudiants.nom": nom },
        { $set: { "etudiants.$.statut": "Présent", "etudiants.$.heure": new Date().toLocaleTimeString() } }
    );
    res.json({ message: "Présence enregistrée !" });
});

// ROUTE 3 : Voir toutes les archives
app.get('/archives', async (req, res) => {
    const toutesLesSeances = await Seance.find();
    res.json(toutesLesSeances);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur sur le port ${PORT}`));