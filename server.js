const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose'); // NOUVEAU: Importation de Mongoose

const app = express();

// Autoriser la communication et la lecture du JSON
app.use(cors());
app.use(express.json());

// Dire au serveur de servir les fichiers du dossier public
app.use(express.static('public'));

// --- NOUVEAUTÉ 1 : CONNEXION À MONGODB ---
// ⚠️ ATTENTION : Remplacez le texte entre les guillemets ci-dessous par VOTRE VRAI LIEN SECRET !
const mongoURI = "mongodb+srv://ahmedmhamdi_db_user:75Deu32ZXLW7H4vn@cluster0.nku2lm5.mongodb.net/?appName=Cluster0";

mongoose.connect(mongoURI)
    .then(() => console.log('📦 Connecté au coffre-fort MongoDB avec succès !'))
    .catch(err => console.log('❌ Erreur de connexion à MongoDB:', err));

// --- NOUVEAUTÉ 2 : CRÉATION DU MODÈLE (La structure de données) ---
const presenceSchema = new mongoose.Schema({
    nom: String,
    token: String,
    heure: String
});
const Presence = mongoose.model('Presence', presenceSchema);


// --- MISE À JOUR : LA ROUTE DE VALIDATION ---
app.post('/valider-presence', async (req, res) => {
    const { nom, token } = req.body;
    
    if (nom && token) {
        try {
            // On prépare la nouvelle entrée pour MongoDB
            const nouvelleEntree = new Presence({ 
                nom: nom, 
                token: token, 
                // On force l'heure de Tunisie, peu importe où se trouve le serveur Render
                heure: new Date().toLocaleTimeString('fr-FR', { timeZone: 'Africa/Tunis' }) 
            });
            
            // On sauvegarde l'étudiant directement dans le coffre-fort !
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

// --- MISE À JOUR : LA LECTURE DES PRÉSENCES ---
app.get('/liste', async (req, res) => {
    try {
        // On demande à MongoDB de nous renvoyer tous les étudiants présents
        const toutesLesPresences = await Presence.find();
        res.json(toutesLesPresences);
    } catch (erreur) {
        res.status(500).json({ erreur: "Impossible de lire la base de données" });
    }
});

// Modification pour que Render puisse choisir son propre port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur en ligne sur le port ${PORT}`);
});