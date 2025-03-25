
# VRChat Poster Bot - Image CDN Hosting

This repository stores user-uploaded poster images for the FBT Luxe VRChat world.

Structure:
- Each user has a folder named after their Discord user ID.
- Inside each folder are poster images (poster_1.png, poster_2.png, ...).

Posters are uploaded via a Discord bot and referenced inside Unity using the GitHub raw CDN:
https://raw.githubusercontent.com/<username>/<repo>/main/poster_uploads/<user_id>/poster_<slot>.png

Make sure your Unity Udon logic constructs the image URLs using this structure.
