/**
 * AIDA — подсказки для Origin/Destination: города (City, ST) и зоны DAT (Z0–Z9, ZC, ZE, ZW, ZM).
 * Зоны как на one.dat.com (How to search by Zones). Расшифровка зон — штаты в скобках.
 * Если города нет в списке — подсказки через Nominatim (OpenStreetMap), бесплатно.
 */
(function (global) {
    'use strict';

    // Зоны DAT (США Z0–Z9, Канада ZC/ZE/ZW, Мексика ZM) с расшифровкой штатов
    var ZONES = [
        'Z0', 'Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7', 'Z8', 'Z9',
        'ZC', 'ZE', 'ZW', 'ZM'
    ];
    var ZONE_LABELS = {
        'Z0': 'CT, ME, MA, NH, NJ, RI, VT',
        'Z1': 'DE, NY, PA',
        'Z2': 'MD, NC, SC, VA, WV',
        'Z3': 'AL, FL, GA, MS, TN',
        'Z4': 'IN, KY, MI, OH',
        'Z5': 'IA, MN, MT, ND, SD, WI',
        'Z6': 'IL, KS, MO, NE',
        'Z7': 'AR, LA, OK, TX',
        'Z8': 'AZ, CO, ID, NV, NM, UT, WY',
        'Z9': 'CA, OR, WA, AK',
        'ZC': 'Central Canada',
        'ZE': 'Eastern Canada',
        'ZW': 'Western Canada',
        'ZM': 'Mexico'
    };

    // Города США в формате "City, ST" (основные для поиска грузов)
    var CITIES = [
        'Chicago, IL', 'Dallas, TX', 'Houston, TX', 'Los Angeles, CA', 'Phoenix, AZ',
        'San Antonio, TX', 'San Diego, CA', 'Philadelphia, PA', 'Jacksonville, FL',
        'Columbus, OH', 'Charlotte, NC', 'Indianapolis, IN', 'Seattle, WA',
        'Denver, CO', 'Boston, MA', 'Nashville, TN', 'Detroit, MI', 'Portland, OR',
        'Las Vegas, NV', 'Memphis, TN', 'Louisville, KY', 'Baltimore, MD',
        'Milwaukee, WI', 'Albuquerque, NM', 'Tucson, AZ', 'Fresno, CA',
        'Sacramento, CA', 'Kansas City, MO', 'Atlanta, GA', 'Miami, FL',
        'Cleveland, OH', 'Raleigh, NC', 'Omaha, NE', 'Oakland, CA',
        'Minneapolis, MN', 'Tulsa, OK', 'Wichita, KS', 'Arlington, TX',
        'Tampa, FL', 'New Orleans, LA', 'Bakersfield, CA', 'Honolulu, HI',
        'Aurora, CO', 'Anaheim, CA', 'Santa Ana, CA', 'St. Louis, MO',
        'Riverside, CA', 'Corpus Christi, TX', 'Pittsburgh, PA', 'Lexington, KY',
        'Anchorage, AK', 'Stockton, CA', 'Cincinnati, OH', 'St. Paul, MN',
        'Toledo, OH', 'Newark, NJ', 'Greensboro, NC', 'Plano, TX',
        'Lincoln, NE', 'Orlando, FL', 'Irvine, CA', 'Newark, NJ',
        'Durham, NC', 'Chula Vista, CA', 'Fort Wayne, IN', 'Jersey City, NJ',
        'St. Petersburg, FL', 'Laredo, TX', 'Madison, WI', 'Chandler, AZ',
        'Lubbock, TX', 'Scottsdale, AZ', 'Reno, NV', 'Norfolk, VA',
        'Gilbert, AZ', 'North Las Vegas, NV', 'Winston-Salem, NC',
        'Irving, TX', 'Hialeah, FL', 'Garland, TX', 'Fremont, CA',
        'Boise, ID', 'Richmond, VA', 'Baton Rouge, LA', 'Des Moines, IA',
        'Spokane, WA', 'San Bernardino, CA', 'Birmingham, AL', 'Rochester, NY',
        'Modesto, CA', 'Fayetteville, NC', 'Salt Lake City, UT', 'Fontana, CA',
        'Oxnard, CA', 'Moreno Valley, CA', 'Glendale, AZ', 'Huntsville, AL',
        'Columbus, GA', 'Grand Rapids, MI', 'Amarillo, TX', 'Yonkers, NY',
        'Grand Prairie, TX', 'Montgomery, AL', 'Aurora, IL', 'Akron, OH',
        'Little Rock, AR', 'Huntington Beach, CA', 'Augusta, GA',
        'Newport News, VA', 'Glendale, CA', 'Shreveport, LA', 'Davenport, IA',
        'Rockford, IL', 'Frisco, TX', 'Tacoma, WA', 'Ontario, CA',
        'Tempe, AZ', 'Santa Clarita, CA', 'Springfield, MO', 'Cape Coral, FL',
        'Pembroke Pines, FL', 'Sioux Falls, SD', 'Peoria, AZ', 'Lancaster, CA',
        'Elk Grove, CA', 'Palmdale, CA', 'Salinas, CA', 'Springfield, MA',
        'Pomona, CA', 'Corona, CA', 'Salem, OR', 'Rockford, IL',
        'Pasadena, TX', 'Fort Collins, CO', 'Joliet, IL', 'Kansas City, KS',
        'Torrance, CA', 'Paterson, NJ', 'Savannah, GA', 'Mesquite, TX',
        'Sunnyvale, CA', 'Pasadena, CA', 'Orange, CA', 'Fullerton, CA',
        'Killeen, TX', 'Dayton, OH', 'McAllen, TX', 'Bellevue, WA',
        'Miramar, FL', 'Hampton, VA', 'West Valley City, UT', 'Warren, MI',
        'Olathe, KS', 'Columbia, SC', 'Sterling Heights, MI', 'New Haven, CT',
        'Waco, TX', 'Thousand Oaks, CA', 'Cedar Rapids, IA', 'Charleston, SC',
        'Visalia, CA', 'Topeka, KS', 'Elizabeth, NJ', 'Gainesville, FL',
        'Thornton, CO', 'Roseville, CA', 'Carrollton, TX', 'Coral Springs, FL',
        'Stamford, CT', 'Simi Valley, CA', 'Concord, CA', 'Hartford, CT',
        'Kent, WA', 'Lafayette, LA', 'Midland, TX', 'Surprise, AZ',
        'Denton, TX', 'Victorville, CA', 'Santa Rosa, CA', 'Palm Bay, FL',
        'Wichita Falls, TX', 'Columbia, MO', 'El Monte, CA', 'Abilene, TX',
        'North Charleston, SC', 'Ann Arbor, MI', 'Beaumont, TX',
        'Vallejo, CA', 'Independence, MO', 'Springfield, IL', 'Lakeland, FL',
        'Elgin, IL', 'Norman, OK', 'Brownsville, TX', 'Lake Forest, CA',
        'Napa, CA', 'Redding, CA', 'Eugene, OR', 'Green Bay, WI',
        'St. Joseph, MO', 'Fort Smith, AR', 'Boulder, CO', 'Flint, MI',
        'South Bend, IN', 'Appleton, WI', 'Fayetteville, AR', 'Lubbock, TX',
        'Trenton, NJ', 'San Angelo, TX', 'Kenosha, WI', 'Wilmington, NC',
        'Greenville, NC', 'Evansville, IN', 'Kalamazoo, MI', 'Port St. Lucie, FL',
        'Santa Maria, CA', 'Tallahassee, FL', 'Rocky Mount, NC', 'Odessa, TX',
        'Southaven, MS', 'Round Rock, TX', 'Santa Fe, NM', 'Athens, GA',
        'Overland Park, KS', 'Thousand Oaks, CA', 'Santa Clara, CA',
        'Erie, PA', 'Green Bay, WI', 'Roanoke, VA', 'San Mateo, CA',
        'Everett, WA', 'Boulder, CO', 'Allentown, PA', 'Columbia, MD',
        'Manchester, NH', 'Reno, NV', 'Waterbury, CT', 'Charleston, WV',
        'Billings, MT', 'Racine, WI', 'Yakima, WA', 'Sparks, NV',
        'Lake Charles, LA', 'Broken Arrow, OK', 'North Little Rock, AR',
        'Berkeley, CA', 'Richardson, TX', 'Arvada, CO', 'East Los Angeles, CA',
        'St. George, UT', 'Cambridge, MA', 'Sugar Land, TX', 'Coeur d\'Alene, ID',
        'Lewisville, TX', 'Murfreesboro, TN', 'League City, TX', 'Lee\'s Summit, MO',
        'Nampa, ID', 'Sandy Springs, GA', 'Bryan, TX', 'Longview, TX',
        'Bismarck, ND', 'Rapid City, SD', 'Edmond, OK', 'Compton, CA',
        'Carmel, IN', 'Arlington Heights, IL', 'Mission Viejo, CA',
        'Spokane Valley, WA', 'Bloomington, MN', 'Burbank, CA',
        'Rochester, MN', 'Albany, NY', 'Fargo, ND', 'Norwalk, CA',
        'Salisbury, MD', 'San Leandro, CA', 'Vacaville, CA', 'El Cajon, CA',
        'Tyler, TX', 'Norwalk, CT', 'Chico, CA', 'San Marcos, TX',
        'New Braunfels, TX', 'Marysville, WA', 'Longmont, CO', 'Bellingham, WA'
    ];

    function normalize(s) {
        return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
    }

    function matchZone(query) {
        var q = normalize(query);
        if (!q) return ZONES.slice();
        return ZONES.filter(function (z) {
            return z.toLowerCase().indexOf(q) === 0;
        });
    }

    function matchCities(query, limit) {
        var q = normalize(query);
        limit = limit || 15;
        if (!q) return CITIES.slice(0, limit);
        var out = [];
        for (var i = 0; i < CITIES.length; i++) {
            var n = normalize(CITIES[i]);
            if (n.indexOf(q) !== -1) out.push(CITIES[i]);
        }
        out.sort(function (a, b) {
            var na = normalize(a);
            var nb = normalize(b);
            var aStart = na.indexOf(q) === 0 ? 1 : 0;
            var bStart = nb.indexOf(q) === 0 ? 1 : 0;
            if (bStart !== aStart) return bStart - aStart;
            return na.localeCompare(nb);
        });
        return out.slice(0, limit);
    }

    function getSuggestions(query, limit) {
        limit = limit || 20;
        var q = (query || '').trim();
        var zones = matchZone(q);
        var cities = matchCities(q, limit - zones.length);
        var seen = {};
        var out = [];
        zones.forEach(function (z) {
            if (!seen[z]) {
                seen[z] = true;
                var label = ZONE_LABELS[z] ? z + ' (' + ZONE_LABELS[z] + ')' : z;
                out.push({ value: z, type: 'zone', label: label });
            }
        });
        cities.forEach(function (c) {
            if (!seen[c]) { seen[c] = true; out.push({ value: c, type: 'city', label: c }); }
        });
        return out.slice(0, limit);
    }

    var lastOnlineRequest = 0;
    var NOMINATIM_MIN_INTERVAL = 1100;

    function fetchOnlineSuggestions(query, limit, callback) {
        var q = (query || '').trim();
        if (q.length < 2) { callback([]); return; }
        var now = Date.now();
        if (now - lastOnlineRequest < NOMINATIM_MIN_INTERVAL) {
            callback([]);
            return;
        }
        lastOnlineRequest = now;
        var url = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q + ', USA') + '&format=json&addressdetails=1&limit=' + (limit || 10);
        // User-Agent и Referer нельзя задавать из скрипта расширения — браузер их блокирует; запрос идёт с заголовками по умолчанию.
        var req = new XMLHttpRequest();
        req.open('GET', url);
        req.setRequestHeader('Accept', 'application/json');
        req.onreadystatechange = function () {
            if (req.readyState !== 4) return;
            var out = [];
            try {
                var list = JSON.parse(req.responseText || '[]');
                var seen = {};
                for (var i = 0; i < list.length; i++) {
                    var a = list[i].address;
                    if (!a) continue;
                    var city = a.city || a.town || a.village || a.municipality || a.county || '';
                    var state = a.state && a.state.length === 2 ? a.state : (a.state_code || '');
                    if (!city && !state) continue;
                    if (!state && a.state) state = stateAbbr(a.state);
                    var label = state ? (city + ', ' + state) : (city || a.display_name.split(',')[0]);
                    if (!label || seen[label]) continue;
                    seen[label] = true;
                    out.push({ value: label, type: 'city', label: label });
                }
            } catch (e) {}
            callback(out);
        };
        req.send();
    }

    function stateAbbr(name) {
        var map = { 'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA','Colorado':'CO','Connecticut':'CT','Delaware':'DE','Florida':'FL','Georgia':'GA','Hawaii':'HI','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA','Kansas':'KS','Kentucky':'KY','Louisiana':'LA','Maine':'ME','Maryland':'MD','Massachusetts':'MA','Michigan':'MI','Minnesota':'MN','Mississippi':'MS','Missouri':'MO','Montana':'MT','Nebraska':'NE','Nevada':'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND','Ohio':'OH','Oklahoma':'OK','Oregon':'OR','Pennsylvania':'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD','Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT','Virginia':'VA','Washington':'WA','West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY','District of Columbia':'DC' };
        return map[name] || (name.length === 2 ? name : '');
    }

    global.AIDALocations = {
        ZONES: ZONES,
        ZONE_LABELS: ZONE_LABELS,
        CITIES: CITIES,
        getSuggestions: getSuggestions,
        fetchOnlineSuggestions: fetchOnlineSuggestions
    };
})(typeof window !== 'undefined' ? window : this);
