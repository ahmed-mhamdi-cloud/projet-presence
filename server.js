const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// CONNEXION MONGODB
const mongoURI = "mongodb+srv://ahmedmhamdi_db_user:75Deu32ZXLW7H4vn@cluster0.nku2lm5.mongodb.net/presence_db?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(mongoURI)
  .then(() => console.log("✅ Connecté à MongoDB Atlas"))
  .catch(err => console.log("❌ Erreur :", err));

// SCHÉMAS
const Seance = mongoose.model('Seance', new mongoose.Schema({
    matiere: String,
    date: String,
    etudiants: Array // Contiendra {nom, s1, s2}
}));

const EtudiantOfficiel = mongoose.model('Etudiant', new mongoose.Schema({ nom: String }), 'etudiants');

// ROUTE 1 : DEMARRER SEANCE
app.post('/demarrer-seance', async (req, res) => {
    try {
        const { matiere, date } = req.body;
        let seanceExistante = await Seance.findOne({ matiere: matiere, date: date });

        if (!seanceExistante) {
            // On récupère vos 4 étudiants
            const listeInscrits = await EtudiantOfficiel.find();
            
            if (listeInscrits.length === 0) {
                return res.status(400).json({ error: "Votre collection d'étudiants dans MongoDB est vide." });
            }

            // On prépare la liste où tout le monde est Absent au début
            const tableauInitial = listeInscrits.map(e => ({
                nom: e.nom,
                s1: "Absent",
                s2: "Absent"
            }));
            
            seanceExistante = new Seance({ matiere, date, etudiants: tableauInitial });
            await seanceExistante.save();
        }
        res.json({ message: "Séance prête" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ROUTE 2 : VALIDER PRESENCE (POUR SÉANCE 1 ET SÉANCE 2)
app.post('/valider-presence', async (req, res) => {
    try {
        const { nom, date, matiere, typeSeance } = req.body;
        
        let seanceExistante = await Seance.findOne({ date: date, matiere: matiere });
        if (!seanceExistante) {
            return res.status(400).json({ error: "Séance introuvable." });
        }

        const nomSaisi = nom.trim().toLowerCase();
        let etudiantTrouve = false;

        // On cherche l'étudiant et on met à jour la bonne séance (1 ou 2)
        for (let i = 0; i < seanceExistante.etudiants.length; i++) {
            if (seanceExistante.etudiants[i].nom.toLowerCase() === nomSaisi) {
                if (typeSeance === "Séance 1") seanceExistante.etudiants[i].s1 = "Présent";
                if (typeSeance === "Séance 2") seanceExistante.etudiants[i].s2 = "Présent";
                etudiantTrouve = true;
                break;
            }
        }

        if (!etudiantTrouve) {
            return res.status(400).json({ error: "Étudiant introuvable dans la liste." });
        }

        // On sauvegarde les modifications dans MongoDB
        seanceExistante.markModified('etudiants');
        await seanceExistante.save();

        res.json({ message: "Présence enregistrée avec succès !" });
    } catch (err) {
        res.status(500).json({ error: "Erreur serveur" });
    }
});

// ROUTE 3 : ARCHIVES
app.get('/archives', async (req, res) => {
    const data = await Seance.find().sort({ _id: -1 });
    res.json(data);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Serveur actif sur port ${PORT}`));