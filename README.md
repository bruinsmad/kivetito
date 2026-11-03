# Kivetítő

Laptop képernyőjének kivetítése az okostáblára egy kattintással. Nem kell URL-t gépelni, és nincs képernyőválasztó ablak.

- **`board/`**: Android alkalmazás a táblára. Bekapcsoláskor elindul a háttérben, és amikor valaki megoszt, automatikusan előjön teljes képernyőn. A végén visszaadja a táblát az előző alkalmazásnak.
- **`laptop/`**: tálca-/menüsor-alkalmazás Macre és Windowsra (Electron). Megtalálja a hálózaton lévő táblákat. Kattints a tábla nevére, és indul a kivetítés.
- **`relay/`**: kis szerver a Mac minire. Ha az iskolai hálózat nem engedi, hogy a laptop közvetlenül elérje a táblát (pl. külön Wi-Fi/VLAN), a forgalom ezen keresztül megy. Az app először mindig a közvetlen kapcsolatot próbálja, a relayt csak akkor használja, ha az nem megy.

## Elkészítés

**A legegyszerűbb: GitHub Actions.** Töltsd fel a mappát egy GitHub-repóba (`main` ág). Az *Actions* fülön a *Build* folyamat három fájlt készít:
`Kivetito-tabla-apk`, `Kivetito-mac` (.dmg), `Kivetito-windows` (.exe telepítő).

**Helyben:**
- Tábla-APK: nyisd meg a `board/` mappát Android Studióban, majd *Build → Build APK(s)*. Parancssorból: `./gradlew assembleRelease`.
- Mac: `cd laptop && npm install && npm run dist:mac`. Ha van Developer ID tanúsítványod a kulcskarikában, automatikusan aláírja vele.
- Windows: ugyanez Windows gépen, `npm run dist:win` paranccsal.

## Relay beállítása a Mac minin (egyszer)

1. Másold a `relay/` mappát a Mac minire, majd: `cd relay && npm install && node server.js`. Alapból a `127.0.0.1:8787` címen fut.
2. **Cloudflare Tunnel:** adj hozzá egy public hostname-et a tunnelhez: `kivetito.bruinsma.lol` → `http://localhost:8787`. A WebSocket alapból működik.
   Ha Caddyn keresztül vezeted: `kivetito.bruinsma.lol { reverse_proxy 127.0.0.1:8787 }`.
3. **Automatikus indítás:** írd át a `relay/lol.bruinsma.kivetito-relay.plist` fájlban a két útvonalat, másold a `~/Library/LaunchAgents/` mappába, majd:
   `launchctl load ~/Library/LaunchAgents/lol.bruinsma.kivetito-relay.plist`
4. Ellenőrzés böngészőben: `https://kivetito.bruinsma.lol` → *Kivetítő relay OK – N tábla online*.

A relay címe mindkét appban `wss://kivetito.bruinsma.lol`. A táblán a **Relay…** gombbal, a laptopon a `config.json` `relayUrl` mezőjében írható át.

## Telepítés

**Tábla (egyszer):**
1. Másold át az APK-t pendrive-on, és telepítsd a fájlkezelőből (engedélyezd az ismeretlen forrásokat).
2. Nyisd meg a Kivetítőt, és koppints az **Automatikus megjelenés engedélyezése** gombra. Erre azért van szükség, hogy megosztáskor magától előjöjjön.
3. **Tábla neve…**: adj neki nevet, pl. *204-es terem*.

**Laptop (egyszer):**
- Mac: első megosztáskor engedélyezd a *Képernyőfelvételt* (Rendszerbeállítások → Adatvédelem és biztonság), majd indítsd újra az appot. Ha a GitHubról letöltött, aláíratlan verziót a macOS „sérültnek” mondja: `xattr -cr /Applications/Kivetito.app`
- Windows: a SmartScreen figyelmeztet, mert a program aláíratlan. Kattints a *További információ → Futtatás mindenképp* lehetőségre.
- Az app bejelentkezéskor magától elindul.

## Használat

1. Kattints a Kivetítő ikonra a menüsorban/tálcán, és válaszd ki a táblát.
   - Ha a tábla más hálózaton van, de ugyanabból az iskolából (ugyanarról a nyilvános IP-ről) éri el az internetet, a relayen át magától megjelenik (☁ jel).
   - Ha nem jelenik meg: *Tábla hozzáadása (kód vagy IP-cím)…*, és írd be a táblán látható **6 jegyű kódot**. Ezt csak egyszer kell megtenni.
2. **Első alkalommal** a táblán megjelenik: *„… szeretné kivetíteni a képernyőjét”*. Koppints az **Engedélyez** gombra. Ezután ez a laptop kérdés nélkül csatlakozik.
3. Leállítás: kattints újra a táblára a menüben, vagy használd a **⌘⇧K / Ctrl+Shift+K** billentyűt. Ugyanez a billentyű indítja is a kivetítést az utolsó táblára.

A táblán: ha megérinted a képet, megjelenik a **Leállítás** gomb. Ha egy másik engedélyezett laptop kezd kivetíteni, átveszi a helyet.

## Hibaelhárítás

- **Nem jelenik meg tábla a listában:** add hozzá a táblán látható 6 jegyű kóddal (relayen át). Ha a tábla azt írja, hogy *Relay nem érhető el*, ellenőrizd, hogy fut-e a relay a Mac minin, és hogy a tábla eléri-e az internetet.
- **Interneten át (☁) akadozik:** ilyenkor a kép a Mac minin keresztül megy, ezért az app automatikusan kisebb felbontást és képkockaszámot használ. Közvetlen kapcsolathoz a rendszergazdának engedélyeznie kell a laptop → tábla forgalmat: **TCP 47800**, **UDP 47801**.
- **Akadozik:** Beállítások → Képminőség → *Alacsony*. Videóhoz: *Magas*.
- **Nem ugrik elő a táblán:** egyes táblák nem adják meg az „Automatikus megjelenés” engedélyt. Ilyenkor nyisd meg kézzel a Kivetítőt a megosztás előtt.

A helyi hálózaton a kép titkosítatlanul megy (JPEG képkockák), a relayen át viszont titkosítva (HTTPS/WSS). A táblára csak olyan laptop vetíthet, amelyet a táblán egyszer engedélyeztél.
