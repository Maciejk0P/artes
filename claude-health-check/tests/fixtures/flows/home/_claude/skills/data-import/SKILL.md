---
name: data-import
description: Imports a spreadsheet export into the local database. Use when the user asks to import or load a data file.
---

# Data import

Work through the steps in order.

## Step 1: Locate the file

Ask for the path when the user did not give one.

1. Look in the `incoming/` folder first.
2. Then look in the folder the user named.
3. Take the newest file.
4. Remember its name.

## Step 2 - Validate the columns

- If a required column is missing, list the missing columns and stop.
- Check the date format.

## Step 3

Load the rows in batches of 500. Keep a count of the rows that were skipped.

## Step 4: Report

Print how many rows were loaded.

## Notes

Dates are read as day, month, year.
