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
const SeanceSchema = new mongoose.Schema({
    matiere: String,
    date: String,
    etudiants: Array // Chaque étudiant aura {nom, s1: "Absent", s2: "Absent"}
});
const Seance = mongoose.model('Seance', SeanceSchema);
const EtudiantOfficiel = mongoose.model('Etudiant', new mongoose.Schema({ nom: String }), 'etudiants_inscrits');

// ROUTES
app.post('/demarrer-seance', async (req, res) => {
    try {
        const { matiere, date, typeSeance } = req.body; // typeSeance est "Séance 1" ou "Séance 2"
        let seanceExistante = await Seance.findOne({ matiere, date });

        if (!seanceExistante) {
            // Première fois qu'on lance cette matière aujourd'hui
            const listeInscrits = await EtudiantOfficiel.find();
            const tableauInitial = listeInscrits.map(e => ({
                nom: e.nom,
                s1: "Absent",
                s2: "Absent"
            }));
            seanceExistante = new Seance({ matiere, date, etudiants: tableauInitial });
            await seanceExistante.save();
        }
        res.json({ message: `${typeSeance} démarrée pour ${matiere}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/valider-presence', async (req, res) => {
    try {
        const { nom, date, matiere, typeSeance } = req.body;
        const champStatut = typeSeance === "Séance 1" ? "etudiants.$.s1" : "etudiants.$.s2";
        
        await Seance.updateOne(
            { date, matiere, "etudiants.nom": nom },
            { $set: { [champStatut]: "Présent" } }
        );
        res.json({ message: "Présence enregistrée" });
    } catch (err) {
        res.status(500).json({ error: "Erreur scan" });
    }
});

app.get('/archives', async (req, res) => {
    const data = await Seance.find().sort({ _id: -1 });
    res.json(data);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Serveur actif`));