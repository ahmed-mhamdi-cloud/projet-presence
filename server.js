const express = require('express');
const cors = require('cors');

const app = express();

// Autoriser la communication et la lecture du JSON
app.use(cors());
app.use(express.json());

// Dire au serveur de servir les fichiers du dossier public
app.use(express.static('public'));

// --- NOUVEAUTÉ : LA LISTE DES PRÉSENCES ---
let listePresences = [];

// --- NOUVEAUTÉ : LA ROUTE DE VALIDATION ---
app.post('/valider-presence', (req, res) => {
    const { nom, token } = req.body;
    
    if (nom && token) {
        // On ajoute l'étudiant à la liste avec l'heure actuelle
        const nouvelleEntree = { 
            nom: nom, 
            token: token, 
            heure: new Date().toLocaleTimeString() 
        };
        listePresences.push(nouvelleEntree);
        
        // Affiche la confirmation dans votre terminal VS Code
        console.log(`✅ Présence validée : ${nom} (Jeton: ${token})`);
        
        res.json({ message: "Présence enregistrée !" });
    } else {
        res.status(400).json({ erreur: "Données manquantes" });
    }
});

// Route pour que le prof puisse voir la liste (optionnel pour plus tard)
app.get('/liste', (req, res) => {
    res.json(listePresences);
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur mis à jour et en ligne sur http://localhost:${PORT}`);
});