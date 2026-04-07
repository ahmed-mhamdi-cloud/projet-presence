const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();

// Autoriser la communication et la lecture du JSON
app.use(cors());
app.use(express.json());

// Dire au serveur de servir les fichiers du dossier public
app.use(express.static('public'));

// ==========================================
// 1. CONNEXION À MONGODB
// ==========================================
// ⚠️ Ajout de "GestionPresences" dans l'URL pour pointer vers la bonne base
const mongoURI = "mongodb+srv://ahmedmhamdi_db_user:75Deu32ZXLW7H4vn@cluster0.nku2lm5.mongodb.net/GestionPresences?appName=Cluster0";

mongoose.connect(mongoURI)
    .then(() => console.log('📦 Connecté au coffre-fort MongoDB (GestionPresences) avec succès !'))
    .catch(err => console.log('❌ Erreur de connexion à MongoDB:', err));

// ==========================================
// 2. LES MODÈLES DE DONNÉES (La structure)
// ==========================================

// --- NOUVEAU : La liste officielle des étudiants inscrits ---
const etudiantInscritSchema = new mongoose.Schema({
    nom: String,
    classe: String
});
// On relie ce modèle à la collection exacte 'etudiants_inscrits' créée sur MongoDB Atlas
const EtudiantInscrit = mongoose.model('EtudiantInscrit', etudiantInscritSchema, 'etudiants_inscrits');


// --- ANCIEN : L'enregistrement des présences (scans) ---
const presenceSchema = new mongoose.Schema({
    nom: String,
    token: String,
    heure: String
});
const Presence = mongoose.model('Presence', presenceSchema);


// ==========================================
// 3. LES ROUTES (Les actions du serveur)
// ==========================================

// --- NOUVEAUTÉ : Route pour envoyer la liste officielle au professeur ---
app.get('/liste-officielle', async (req, res) => {
    try {
        const liste = await EtudiantInscrit.find();
        res.json(liste); // Envoie vos 4 étudiants au format JSON
    } catch (error) {
        console.log('Erreur liste officielle:', error);
        res.status(500).send("Erreur lors de la récupération de la liste");
    }
});


// --- MISE À JOUR : Validation de la présence (Scan de l'étudiant) ---
app.post('/valider-presence', async (req, res) => {
    const { nom, token } = req.body;
    
    if (nom && token) {
        try {
            const nouvelleEntree = new Presence({ 
                nom: nom, 
                token: token, 
                heure: new Date().toLocaleTimeString('fr-FR', { timeZone: 'Africa/Tunis' }) 
            });
            
            await nouvelleEntree.save(); 
            
            console.log(`✅ Présence sauvegardée dans MongoDB : ${nom}`);
            res.json({ message: "Présence enregistrée définitivement !" });
        } catch (erreur) {
            console.log('Erreur de sauvegarde:', erreur);
            res.status(500).json({ erreur: "Erreur lors de la sauvegarde" });
        }
    } else {
        res.status(400).json({ erreur: "Données manquantes" });
    }
});


// --- LECTURE DES PRÉSENCES (Historique) ---
app.get('/liste', async (req, res) => {
    try {
        const toutesLesPresences = await Presence.find();
        res.json(toutesLesPresences);
    } catch (erreur) {
        res.status(500).json({ erreur: "Impossible de lire la base de données" });
    }
});


// ==========================================
// 4. LANCEMENT DU SERVEUR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur en ligne sur le port ${PORT}`);
});