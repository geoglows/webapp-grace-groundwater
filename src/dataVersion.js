/**
 * Bump this when the zarr stores are rebuilt with different values.
 *
 * Nothing else tells the app its saved copy is out of date. A cache entry is
 * filed under the store URL, the variable name and the array's shape, and a
 * rebuild that corrects values changes none of those — same URL, same variable,
 * same number of months — so the old copy keeps being used, indefinitely and
 * silently. Adding new months does change the shape and does invalidate itself;
 * a correction to existing months does not.
 *
 * This string is part of every cache key, so changing it makes every browser
 * refetch on its next visit. It is the automatic version of the "Clear cached
 * data" button in settings, which stays as the manual escape hatch.
 *
 * History:
 *   1  original
 *   2  CANa stored as float32 rounded to 4 decimals rather than whole cm,
 *      which had made it identically zero (data/main.py)
 */
export const DATA_VERSION = "v2";
