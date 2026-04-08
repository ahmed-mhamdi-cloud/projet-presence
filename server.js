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
    etudiants: Array // Chaque étudiant: {nom, s1: "Absent", s2: "Absent"}
}));
const EtudiantOfficiel = mongoose.model('Etudiant', new mongoose.Schema({ nom: String }), 'etudiants_inscrits');

// ROUTES
app.post('/demarrer-seance', async (req, res) => {
    try {
        const { matiere, date, typeSeance } = req.body;
        let seanceExistante = await Seance.findOne({ matiere: matiere, date: date });

        if (!seanceExistante) {
            // Chercher les étudiants dans la base
            let listeInscrits = await EtudiantOfficiel.find();
            
            // SÉCURITÉ : Si la liste est vide dans MongoDB, on met des étudiants par défaut
            if (listeInscrits.length === 0) {
                listeInscrits = [{ nom: "Ahmed Mhamdi" }, { nom: "Mohamed Ali" }, { nom: "Fatima Zahra" }];
            }

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

app.post('/valider-presence', async (req, res) => {
    try {
        const { nom, date, matiere, typeSeance } = req.body;
        
        // On détermine si on modifie la colonne s1 ou s2
        const champStatut = typeSeance === "Séance 1" ? "etudiants.$.s1" : "etudiants.$.s2";
        
        const resultat = await Seance.updateOne(
            { date: date, matiere: matiere, "etudiants.nom": nom },
            { $set: { [champStatut]: "Présent" } }
        );

        if (resultat.modifiedCount === 0) {
            return res.status(400).json({ error: "Étudiant non trouvé dans la liste de cette séance." });
        }
        res.json({ message: "Présence enregistrée avec succès !" });
    } catch (err) {
        res.status(500).json({ error: "Erreur serveur lors du scan" });
    }
});

app.get('/archives', async (req, res) => {
    const data = await Seance.find().sort({ _id: -1 });
    res.json(data);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Serveur actif sur port ${PORT}`));