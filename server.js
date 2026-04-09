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
    etudiants: Array // Stocke {nom, s1, s2}
}));

// On cible la collection 'etudiants' où vous avez mis vos 4 noms
const EtudiantOfficiel = mongoose.model('Etudiant', new mongoose.Schema({ nom: String }), 'etudiants');

// ROUTE 1 : DEMARRER SEANCE (Importe la liste complète)
app.post('/demarrer-seance', async (req, res) => {
    try {
        const { matiere, date } = req.body;
        let seanceExistante = await Seance.findOne({ matiere: matiere, date: date });

        if (!seanceExistante) {
            // Récupération des 4 étudiants depuis MongoDB
            const listeInscrits = await EtudiantOfficiel.find();
            
            // Initialisation de TOUT LE MONDE en "Absent"
            const tableauInitial = listeInscrits.map(e => ({
                nom: e.nom,
                s1: "Absent",
                s2: "Absent"
            }));
            
            seanceExistante = new Seance({ matiere, date, etudiants: tableauInitial });
            await seanceExistante.save();
        }
        res.json({ message: "Séance prête avec la liste officielle." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ROUTE 2 : VALIDER PRESENCE
app.post('/valider-presence', async (req, res) => {
    try {
        const { nom, date, matiere, typeSeance } = req.body;
        let seanceExistante = await Seance.findOne({ date: date, matiere: matiere });

        if (!seanceExistante) return res.status(400).json({ error: "Séance non démarrée." });

        const nomSaisi = nom.trim().toLowerCase();
        let etudiantTrouve = false;

        // Recherche dans la liste de la séance
        for (let i = 0; i < seanceExistante.etudiants.length; i++) {
            if (seanceExistante.etudiants[i].nom.toLowerCase() === nomSaisi) {
                if (typeSeance === "Séance 1") seanceExistante.etudiants[i].s1 = "Présent";
                if (typeSeance === "Séance 2") seanceExistante.etudiants[i].s2 = "Présent";
                etudiantTrouve = true;
                break;
            }
        }

        if (!etudiantTrouve) {
            return res.status(400).json({ error: "❌ Étudiant introuvable dans la base officielle." });
        }

        seanceExistante.markModified('etudiants');
        await seanceExistante.save();
        res.json({ message: "✅ Présence enregistrée !" });
    } catch (err) {
        res.status(500).json({ error: "Erreur serveur" });
    }
});

app.get('/archives', async (req, res) => {
    const data = await Seance.find().sort({ _id: -1 });
    res.json(data);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Port ${PORT}`));