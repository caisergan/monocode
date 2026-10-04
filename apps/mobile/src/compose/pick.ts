// Picking photos (12 §12.10 steps 1-3): the photo library (PHPicker, so no
// library permission) or the camera, then each image re-encoded as JPEG 0.85
// at most 2,048 px on the long edge. Re-encoding drops EXIF, location
// included.

import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { MAX_ATTACHMENT_BYTES, base64Bytes } from "@/sync/upload";

const LONG_EDGE = 2_048;

export type PickedImage = { uri: string; name: string; mimeType: string; size: number; base64: string };

async function normalise(asset: ImagePicker.ImagePickerAsset, index: number): Promise<PickedImage> {
  const context = ImageManipulator.manipulate(asset.uri);
  if (Math.max(asset.width, asset.height) > LONG_EDGE)
    context.resize(asset.width >= asset.height ? { width: LONG_EDGE } : { height: LONG_EDGE });
  const image = await context.renderAsync();
  try {
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.85, base64: true });
    const base64 = saved.base64 ?? "";
    const size = base64Bytes(base64);
    if (size > MAX_ATTACHMENT_BYTES) throw new Error("Files can be up to 20 MB.");
    const stem = (asset.fileName ?? `photo-${index + 1}`).replace(/\.[^.]+$/, "");
    return { uri: saved.uri, name: `${stem}.jpg`, mimeType: "image/jpeg", size, base64 };
  } finally {
    image.release();
    context.release();
  }
}

/** Up to `limit` photos from the library; empty when cancelled. */
export async function pickPhotos(limit: number): Promise<PickedImage[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: limit,
    orderedSelection: true,
    quality: 1,
  });
  if (result.canceled) return [];
  return Promise.all(result.assets.slice(0, limit).map(normalise));
}

/** One photo from the camera; empty when cancelled. */
export async function takePhoto(): Promise<PickedImage[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error("Allow camera access in Settings to take photos.");
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 });
  if (result.canceled) return [];
  return Promise.all(result.assets.slice(0, 1).map(normalise));
}
