export async function persistStorageV2ReduxSlice(sliceName: string, value: unknown) {
  const importLegacyReduxSnapshot = window.api?.storageV2?.importLegacyReduxSnapshot

  if (typeof importLegacyReduxSnapshot !== 'function') {
    throw new Error('Storage v2 Redux slice import API unavailable')
  }

  await importLegacyReduxSnapshot(
    {
      redux: {
        [sliceName]: value
      }
    },
    { dryRun: false, pruneMissing: true }
  )
}
