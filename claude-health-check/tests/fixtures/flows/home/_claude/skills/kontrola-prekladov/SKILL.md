---
name: kontrola-prekladov
description: Skontroluje, či majú všetky jazykové súbory rovnaké kľúče. Použi, keď používateľ žiada kontrolu prekladov.
---

# Kontrola prekladov

1. Načítaj všetky súbory z priečinka `locales/`.
2. Ak priečinok neexistuje, povedz to a skonči.
3. Porovnaj kľúče každého jazyka s angličtinou.
   - Keď v jazyku chýba kľúč, zapíš ho do zoznamu.
   - Inak pokračuj ďalším jazykom.
4. Ked je zoznam prázdny, napíš, že je všetko v poriadku. Inak vypíš zoznam chýbajúcich kľúčov.
5. Ulož správu.
