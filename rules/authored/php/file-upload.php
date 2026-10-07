<?php
// ruleid: radr.php.file-upload
move_uploaded_file($_FILES['f']['tmp_name'], '/var/www/uploads/' . $_FILES['f']['name']);
$name = $_FILES['doc']['name'];
// ruleid: radr.php.file-upload
move_uploaded_file($_FILES['doc']['tmp_name'], 'uploads/' . $name);
// ok: radr.php.file-upload
move_uploaded_file($_FILES['f']['tmp_name'], '/var/store/' . bin2hex(random_bytes(16)) . '.bin');
