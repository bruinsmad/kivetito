# Kivetítő

Laptop képernyőjének kivetítése az okostáblára egy kattintással. Nem kell URL-t gépelni, és nincs képernyőválasztó ablak.

- **`board/`**: Android alkalmazás a táblára. Bekapcsoláskor elindul a háttérben, és amikor valaki megoszt, automatikusan előjön teljes képernyőn. A végén visszaadja a táblát az előző alkalmazásnak.
- **`laptop/`**: tálca-/menüsor-alkalmazás Macre és Windowsra (Electron). Megtalálja a hálózaton lévő táblákat. Kattints a tábla nevére, és indul a kivetítés.

## Elkészítés

**A legegyszerűbb: GitHub Actions.** Töltsd fel a mappát egy GitHub-repóba (`main` ág). Az *Actions* fülön a *Build* folyamat három fájlt készít:
`Kivetito-tabla-apk`, `Kivetito-mac` (.dmg), `Kivetito-windows` (.exe telepítő).

**Helyben:**
- Tábla-APK: nyisd meg a `board/` mappát Android Studióban, majd *Build → Build APK(s)*. Parancssorból: `./gradlew assembleRelease`.
- Mac: `cd laptop && npm install && npm run dist:mac`. Ha van Developer ID tanúsítványod a kulcskarikában, automatikusan aláírja vele.
- Windows: ugyanez Windows gépen, `npm run dist:win` paranccsal.

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
2. **Első alkalommal** a táblán megjelenik: *„… szeretné kivetíteni a képernyőjét”*. Koppints az **Engedélyez** gombra. Ezután ez a laptop kérdés nélkül csatlakozik.
3. Leállítás: kattints újra a táblára a menüben, vagy használd a **⌘⇧K / Ctrl+Shift+K** billentyűt. Ugyanez a billentyű indítja is a kivetítést az utolsó táblára.

A táblán: ha megérinted a képet, megjelenik a **Leállítás** gomb. Ha egy másik engedélyezett laptop kezd kivetíteni, átveszi a helyet.

## Hibaelhárítás

- **Nem jelenik meg tábla a listában:** az iskolai hálózat valószínűleg tiltja a broadcastot vagy elszigeteli a klienseket. Próbáld a *Tábla hozzáadása IP-cím alapján…* menüpontot; az IP a táblán, a Kivetítő képernyőjén látszik. Ha így sem megy, a rendszergazdának engedélyeznie kell a laptop → tábla forgalmat: **TCP 47800**, **UDP 47801**.
- **Akadozik:** Beállítások → Képminőség → *Alacsony*. Videóhoz: *Magas*.
- **Nem ugrik elő a táblán:** egyes táblák nem adják meg az „Automatikus megjelenés” engedélyt. Ilyenkor nyisd meg kézzel a Kivetítőt a megosztás előtt.

A kép titkosítatlanul megy a helyi hálózaton (JPEG képkockák). Érzékeny adatot ne vetíts nyilvános Wi-Fi-n.
