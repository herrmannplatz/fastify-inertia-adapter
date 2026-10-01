<script setup lang="ts">
import { Deferred, Head, InfiniteScroll, router } from '@inertiajs/vue3'
import Layout from '../../Layout.vue'

type User = { id: number; name: string }

defineProps<{
  users: { data: User[] }
  stats?: { total: number }
  countries: string[]
  filters?: { roles: string[] }
  activity: { id: number; text: string }[]
}>()

const loadFilters = () => router.reload({ only: ['filters'] })
</script>

<template>
  <Head title="Users" />
  <Layout>
    <h1>Users</h1>

    <Deferred data="stats">
      <template #fallback><p>Loading stats…</p></template>
      <p>Total: {{ stats?.total }}</p>
    </Deferred>

    <InfiniteScroll data="users">
      <ul>
        <li v-for="user in users.data" :key="user.id">{{ user.name }}</li>
      </ul>
    </InfiniteScroll>

    <p>Countries: {{ countries.join(', ') }}</p>

    <p>
      <button v-if="!filters" @click="loadFilters">Load filters</button>
      <span v-else>Roles: {{ filters.roles.join(', ') }}</span>
    </p>

    <h2>Activity</h2>
    <ul>
      <li v-for="item in activity" :key="item.id">{{ item.text }}</li>
    </ul>
  </Layout>
</template>
