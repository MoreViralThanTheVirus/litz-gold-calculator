const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let priceCache = {
    lastUpdated: null,
    goldPricePerGram: null,
    products: [],
    status: 'pending',
    error: null
};

const productConfig = [
    { id: '1g-minted', name: '1 gram', weight: 1, type: 'minted', category: 'Minted Bars' },
    { id: '5g-minted', name: '5 grams', weight: 5, type: 'minted', category: 'Minted Bars' },
    { id: '50g-minted', name: '50 grams', weight: 50, type: 'minted', category: 'Minted Bars' },
    { id: '100g-minted', name: '100 grams', weight: 100, type: 'minted', category: 'Minted Bars' },
    { id: '5g-lunar', name: '5 grams Lunar Horse', weight: 5, type: 'lunar', category: 'Minted Bars' },
    { id: '10g-cast', name: '10 grams', weight: 10, type: 'cast', category: 'Cast Bars' },
    { id: '20g-cast', name: '20 grams', weight: 20, type: 'cast', category: 'Cast Bars' },
    { id: '50g-cast', name: '50 grams', weight: 50, type: 'cast', category: 'Cast Bars' },
    { id: '100g-cast', name: '100 grams', weight: 100, type: 'cast', category: 'Cast Bars' },
    { id: '1oz-lunar', name: '1 Ounce Lunar Horse', weight: 31.1035, type: 'lunar-oz', category: 'Cast Bars' }
];

const premiums = {
    minted: { 1: 0.13, 5: 0.06, 50: 0.01, 100: 0.005 },
    cast: { 10: 0.045, 20: 0.025, 50: 0.00, 100: -0.005 },
    lunar: 0.065,
    'lunar-oz': 0.03
};

async function scrapeMKSPamp() {
    console.log('[' + new Date().toISOString() + '] Starting price scrape...');
    try {
        const response = await axios.get('https://www.mkspamp.com.my/pricing', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml',
            },
            timeout: 15000
        });

        const $ = cheerio.load(response.data);
        let goldPrice = null;

        $('[class*="price"], [class*="gold"]').each((i, el) => {
            const text = $(el).text();
            const match = text.match(/(\d{3}(?:\.\d{2})?)/);
            if (match && !goldPrice) {
                const price = parseFloat(match[1]);
                if (price > 200 && price < 1000) goldPrice = price;
            }
        });

        if (goldPrice) {
            priceCache.goldPricePerGram = goldPrice;
            priceCache.lastUpdated = new Date().toISOString();
            priceCache.status = 'success';
            priceCache.error = null;
            calculateProductPrices();
            console.log('Price updated: RM ' + goldPrice);
        } else {
            throw new Error('Could not extract price');
        }
    } catch (error) {
        console.error('Scrape error:', error.message);
        priceCache.status = 'error';
        priceCache.error = error.message;
    }
}

function calculateProductPrices() {
    if (!priceCache.goldPricePerGram) return;
    const basePrice = priceCache.goldPricePerGram;

    priceCache.products = productConfig.map(product => {
        let premium = 0;
        if (product.type === 'minted') premium = premiums.minted[product.weight] || 0.05;
        else if (product.type === 'cast') premium = premiums.cast[product.weight] || 0.02;
        else if (product.type === 'lunar') premium = premiums.lunar;
        else if (product.type === 'lunar-oz') premium = premiums['lunar-oz'];

        const price = Math.round(basePrice * product.weight * (1 + premium));
        return { ...product, price, priceFormatted: 'RM ' + price.toLocaleString() };
    });
}

app.post('/api/update-base-price', (req, res) => {
    const { basePrice } = req.body;
    if (!basePrice || isNaN(basePrice)) return res.status(400).json({ error: 'Invalid price' });

    priceCache.goldPricePerGram = parseFloat(basePrice);
    priceCache.lastUpdated = new Date().toISOString();
    priceCache.status = 'manual';
    priceCache.error = null;
    calculateProductPrices();
    res.json({ success: true, prices: priceCache });
});

app.get('/api/prices', (req, res) => res.json(priceCache));

app.post('/api/refresh', async (req, res) => {
    await scrapeMKSPamp();
    res.json(priceCache);
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', lastUpdated: priceCache.lastUpdated }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

cron.schedule('*/5 * * * *', () => scrapeMKSPamp());

app.listen(PORT, async () => {
    console.log(`Server running at http://localhost:${PORT}`);
    await scrapeMKSPamp();
});
